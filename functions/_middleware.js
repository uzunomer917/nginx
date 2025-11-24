/**
 * Cloudflare Pages Functions - HLS CDN Proxy (v4 Production Ready)
 * Optimized for: 50k+ Concurrent Users, Tiered Cache & Query String Ignoring
 */

const ORIGIN_URL = 'https://webr00t.global.ssl.fastly.net';
const STABLE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
  const { request, waitUntil } = context;
  const url = new URL(request.url);

  // 1. Preflight & Method Checks
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });

  // 2. Strateji Belirleme
  const isPlaylist = url.pathname.endsWith('.m3u8');
  // Playlist için 2 saniye, Segmentler (.ts, .jpg, .key) için 1 YIL cache
  const cacheTtl = isPlaylist ? 2 : 31536000;
  
  try {
    const cache = caches.default;

    // --- KRİTİK GÜNCELLEME: CACHE KEY NORMALIZATION ---
    // Kullanıcılar ?token=xyz ile gelse bile, biz cache'e sadece dosya adıyla bakacağız.
    // Bu sayede 50k farklı token olsa bile hepsi AYNI cache dosyasından beslenir.
    const cacheKeyUrl = new URL(url.toString());
    
    // .ts ve .jpg için query string'i cache anahtarından sil (Origin'e giderken kalacak!)
    if (!isPlaylist) {
        cacheKeyUrl.search = ''; 
    }
    // Not: Playlistlerde (.m3u8) token bazen içerik değiştirir, o yüzden onlarda silmiyoruz.
    // Eğer m3u8'ler de kişiye özel değilse, yukarıdaki if'i kaldır, hepsinde sil.

    const cacheKey = new Request(cacheKeyUrl.toString(), {
        method: 'GET',
        headers: {} // Header varyasyonlarını yoksay
    });

    // 3. Cache Kontrolü
    let response = await cache.match(cacheKey);

    if (response) {
      const newHeaders = new Headers(response.headers);
      newHeaders.set('CF-Cache-Status', 'HIT');
      newHeaders.set('X-Simulated-Users', '50k-Ready'); // Debug imzası
      Object.keys(corsHeaders).forEach(key => newHeaders.set(key, corsHeaders[key]));
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    }

    // 4. Origin Fetch (Origin'e Tokenlı URL ile git, ama Chrome gibi görün)
    const originHeaders = new Headers();
    originHeaders.set('User-Agent', STABLE_USER_AGENT);
    originHeaders.set('Referer', ORIGIN_URL);
    originHeaders.set('Connection', 'keep-alive');
    
    // Range desteği (Seek için)
    if (request.headers.get('range')) {
        originHeaders.set('Range', request.headers.get('range'));
    }

    const originResponse = await fetch(`${ORIGIN_URL}${url.pathname}${url.search}`, {
      method: request.method,
      headers: originHeaders,
      cf: {
        // Tiered Cache bu ayarla coşar
        cacheTtl: cacheTtl,
        cacheEverything: true
      }
    });

    // 5. Response Hazırlığı
    const responseHeaders = new Headers(originResponse.headers);
    
    // Gereksiz header temizliği
    ['set-cookie', 'via', 'server', 'x-powered-by', 'cf-cache-status', 'cf-ray', 'age'].forEach(h => responseHeaders.delete(h));

    // Browser Cache Ayarları
    Object.keys(corsHeaders).forEach(key => responseHeaders.set(key, corsHeaders[key]));
    responseHeaders.set('Cache-Control', `public, max-age=${cacheTtl}${isPlaylist ? ', must-revalidate' : ', immutable'}`);
    
    if (!originResponse.ok) {
      // Hata alan origin cevabını cacheleme, direkt dön
      return new Response(originResponse.body, { status: originResponse.status, headers: responseHeaders });
    }

    // 6. Akıllı Yazma (Query String'siz Key'e Yazıyoruz!)
    const body = originResponse.body;
    if (!body) return new Response(null, { headers: responseHeaders });

    const [clientStream, cacheStream] = body.tee();

    waitUntil((async () => {
      if (originResponse.status === 200) {
        // Cache'e yazarken temiz headerlarla yaz
        const cacheHeaders = new Headers(responseHeaders);
        // Cache'te tutarken süreyi header'a da işle
        cacheHeaders.set('Cache-Control', `public, max-age=${cacheTtl}`);
        
        await cache.put(cacheKey, new Response(cacheStream, {
          status: originResponse.status,
          headers: cacheHeaders
        }));
      }
    })());

    return new Response(clientStream, {
      status: originResponse.status,
      headers: responseHeaders
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy Error', detail: err.message }), { status: 500, headers: corsHeaders });
  }
}
