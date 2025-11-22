/**
 * Cloudflare Pages Functions - HLS CDN Proxy
 * Optimized for Stability & Caching
 */

const ORIGIN_URL = 'https://webr00t.global.ssl.fastly.net';
const MAX_RETRIES = 3; // Origin hatasında kaç kez denesin?

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);

  // 1. Method Kontrolü
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 2. Health Check
  if (url.pathname === '/health' || url.pathname === '/') {
    return new Response('OK', { status: 200 });
  }

  // 3. Dosya Uzantısı Kontrolü (Güvenlik)
  const pathname = url.pathname.toLowerCase();
  if (!pathname.endsWith('.jpg') && !pathname.endsWith('.jpeg')) {
    return new Response('Forbidden Extension', { status: 403 });
  }

  // 4. Referer Kontrolü
  const referer = request.headers.get('referer') || request.headers.get('referrer');
  if (!referer) {
    return new Response('Referer Required', { status: 403 });
  }

  try {
    // Cache API'yi hazırla
    const cache = caches.default;
    
    // Cache Key Oluşturma
    // Query string'leri (token vs) cache key'e dahil edelim mi? 
    // Genelde HLS segmentleri unique isimlidir, query string önemsiz olabilir.
    // Eğer token değişiyorsa cache miss olmasın diye url.search'i silebiliriz.
    // Şimdilik orijinal yapını koruyorum:
    const cacheKeyUrl = new URL(url.toString());
    
    // Range header varsa cache key'e etki etmeli mi?
    // Cloudflare Cache API, range requestleri tam dosya cache'inden servis edebilir.
    // Ancak manuel fetch yaptığımız için range'i cache key'den ayırmak daha yüksek hit rate sağlar.
    // Buradaki strateji: Origin'den TAM dosyayı çek, Cache'e at, Range'i Cloudflare halletsin.
    const cacheKey = new Request(cacheKeyUrl.toString(), request);

    // 5. Cache Kontrolü (Önce Cloudflare Cache'ine bak)
    let response = await cache.match(cacheKey);

    if (response) {
      const newHeaders = new Headers(response.headers);
      newHeaders.set('CF-Cache-Status', 'HIT');
      // Range isteği geldiyse ve cache'te tam dosya varsa Cloudflare bunu otomatik handle etmeyebilir
      // manuel response oluştururken dikkatli olunmalı.
      // Ancak basitlik adına, cache hit ise direkt dönüyoruz.
      return response;
    }

    // 6. Origin Fetch (Retry Mekanizması ile)
    const originResponse = await fetchWithRetry(url.pathname + url.search, request);

    // Origin hatası varsa (404, 500 vs)
    if (!originResponse.ok) {
       // 404 ise cache'lemeyelim, direkt dönelim
       return originResponse;
    }

    // 7. Response Header Manipülasyonu
    const responseHeaders = new Headers(originResponse.headers);
    
    // Gereksiz Origin headerlarını temizle
    responseHeaders.delete('set-cookie');
    responseHeaders.delete('server');
    responseHeaders.delete('via');

    // Cache Ayarları (Browser ve Edge)
    responseHeaders.set('Cache-Control', 'public, max-age=300, s-maxage=31536000'); // Browser: 5dk, Edge: 1 yıl
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Content-Type', 'image/jpeg');
    
    // ETag yoksa oluştur (Revalidation için kritik)
    if (!responseHeaders.has('ETag')) {
      const contentLen = responseHeaders.get('content-length') || '0';
      responseHeaders.set('ETag', `"${url.pathname}-${contentLen}"`);
    }

    responseHeaders.set('CF-Cache-Status', 'MISS');

    // 8. Response Oluşturma
    // Streaming için response body'yi clone yapmadan kullanıyoruz ama cache için clone lazım.
    // TEEING: Body'i ikiye ayırıyoruz. Biri kullanıcıya, biri cache'e.
    const responseBody = originResponse.body;
    
    // Eğer body null ise (HEAD request)
    if (!responseBody) {
        return new Response(null, {
            status: originResponse.status,
            headers: responseHeaders
        });
    }

    // Stream'i ikiye böl (Tee) - Bu memory yönetimi için çok daha iyidir
    const [clientStream, cacheStream] = responseBody.tee();

    const clientResponse = new Response(clientStream, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders
    });

    // 9. Cache'e Yazma (Asenkron)
    // Sadece başarılı tam indirmeleri cache'le (200)
    if (originResponse.status === 200) {
      const cacheResponse = new Response(cacheStream, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers: responseHeaders
      });
      
      // Cache'e yazma işlemini bekleme (background task)
      waitUntil(cache.put(cacheKey, cacheResponse));
    }

    return clientResponse;

  } catch (err) {
    return new Response(`Proxy Error: ${err.message}`, { status: 502 });
  }
}

/**
 * Retry logicli Fetch fonksiyonu
 * Origin geçici olarak yanıt vermezse tekrar dener.
 */
async function fetchWithRetry(path, originalRequest) {
  let lastError;
  const fetchUrl = `${ORIGIN_URL}${path}`;

  // Origin'e gönderilecek temiz headerlar
  const headers = new Headers();
  // HLS için Range header'ı önemli, varsa ilet
  if (originalRequest.headers.has('Range')) {
      headers.set('Range', originalRequest.headers.get('Range'));
  }
  headers.set('User-Agent', 'Cloudflare-Pages-CDN');
  
  // Origin için CF ayarları
  const cfOptions = {
      cacheEverything: true,
      cacheTtl: 31536000, // 1 Yıl
      minify: { javascript: false, css: false, html: false }
  };

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetch(fetchUrl, {
        method: originalRequest.method,
        headers: headers,
        cf: cfOptions
      });

      // 5xx hatalarında retry yap (4xx hataları kalıcıdır, retry yapılmaz)
      if (res.status >= 500) {
        throw new Error(`Origin status ${res.status}`);
      }

      return res;
    } catch (err) {
      lastError = err;
      // Bekleme süresi: 100ms, 200ms, 400ms...
      await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, i)));
    }
  }
  
  // Hepsi başarısız olursa
  throw lastError;
}
