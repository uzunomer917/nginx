/**
 * Cloudflare Pages Functions - HLS CDN Proxy (v2 Stable)
 * Fixes: CORS Preflight, Stream Handling, Error Headers
 */

const ORIGIN_URL = 'https://webr00t.global.ssl.fastly.net';

// CORS Header'ları standartlaştırıldı
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, X-Requested-With',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag, Last-Modified',
  'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
  const { request, waitUntil } = context;
  const url = new URL(request.url);

  // 1. OPTIONS İsteğini Karşıla (CORS Preflight)
  // Bu olmazsa tarayıcı GET isteğini hiç atmaz.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // 2. Sadece GET ve HEAD'e izin ver
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { 
      status: 405, 
      headers: corsHeaders 
    });
  }

  // 3. Health Check
  if (url.pathname === '/health' || url.pathname === '/') {
    return new Response('OK', { 
      status: 200, 
      headers: corsHeaders 
    });
  }

  try {
    // Cache API
    const cache = caches.default;
    
    // Range varsa cache key'den ayırıyoruz ki ana dosyayı cache'leyebilelim.
    // Ancak Cloudflare free planda range cache yönetimi zordur, bu yüzden
    // HLS segmentleri küçükse range'i cache key'e katmak daha güvenlidir.
    // Şimdilik en basit ve çalışır haliyle URL'i baz alıyoruz.
    const cacheKey = new Request(url.toString(), request);

    // 4. Cache Kontrolü
    let response = await cache.match(cacheKey);

    if (response) {
      // Cache HIT olsa bile CORS headerlarını tazelemek gerekebilir
      const newHeaders = new Headers(response.headers);
      newHeaders.set('CF-Cache-Status', 'HIT');
      // CORS headerlarını üzerine yaz
      Object.keys(corsHeaders).forEach(key => newHeaders.set(key, corsHeaders[key]));

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    }

    // 5. Origin Fetch (Headers Hazırlığı)
    const originHeaders = new Headers();
    
    // Kritik headerları kopyala
    const allowedForwardHeaders = ['range', 'user-agent', 'accept', 'accept-encoding'];
    allowedForwardHeaders.forEach(h => {
      const val = request.headers.get(h);
      if (val) originHeaders.set(h, val);
    });

    // Origin'e istek
    const originResponse = await fetch(`${ORIGIN_URL}${url.pathname}${url.search}`, {
      method: request.method,
      headers: originHeaders,
      cf: {
        cacheTtl: 31536000, // 1 Yıl Edge Cache
        cacheEverything: true
      }
    });

    // 6. Response Header Hazırlığı
    const responseHeaders = new Headers(originResponse.headers);

    // Origin'den gelen gereksizleri sil
    ['set-cookie', 'via', 'server', 'x-powered-by'].forEach(h => responseHeaders.delete(h));

    // CORS ekle
    Object.keys(corsHeaders).forEach(key => responseHeaders.set(key, corsHeaders[key]));

    // Cache Status
    responseHeaders.set('CF-Cache-Status', 'MISS');

    // Eğer Origin hata döndüyse (404, 500 vs) direkt dön (Cache'leme)
    if (!originResponse.ok) {
      return new Response(originResponse.body, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers: responseHeaders
      });
    }

    // 7. Body Handling (Teeing) - Kilitlenmeyi önlemek için
    const body = originResponse.body;
    
    // Eğer body yoksa (HEAD request veya 304) direkt dön
    if (!body) {
      return new Response(null, {
        status: originResponse.status,
        headers: responseHeaders
      });
    }

    // Stream'i ikiye ayır: Biri kullanıcıya, biri cache'e
    const [clientStream, cacheStream] = body.tee();

    // Cache'e kaydetme işlemini arka planda yap (waitUntil)
    waitUntil((async () => {
      try {
        // Range requestleri (206) bazen cache.put ile sorun çıkarabilir.
        // Sadece tam içerikleri (200) cache'lemek daha güvenlidir.
        if (originResponse.status === 200) {
          await cache.put(cacheKey, new Response(cacheStream, {
            status: originResponse.status,
            headers: responseHeaders
          }));
        }
      } catch (e) {
        // Cache hatası olursa client etkilenmesin, logla geç
        console.error('Cache Put Error:', e);
      }
    })());

    // Kullanıcıya yanıt dön
    return new Response(clientStream, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders
    });

  } catch (err) {
    // Global Hata Yakalama
    return new Response(`CDN Proxy Error: ${err.message}`, { 
      status: 500,
      headers: corsHeaders // Hata durumunda bile CORS dönmek şart!
    });
  }
}
