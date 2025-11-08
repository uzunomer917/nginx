/**
 * Cloudflare Pages Functions - CDN Proxy Middleware
 * CloudFront/Fastly benzeri profesyonel CDN sistemi
 * HLS streaming için optimize edilmiş (.jpg dosyaları)
 */

const ORIGIN_URL = 'https://w0rk3rsb4ckd00r.global.ssl.fastly.net';

// Cache süresi ayarları (saniye cinsinden)
const CACHE_DURATION = {
  browser: 300,          // 1 saat browser cache (HLS segment'leri için yeterli)
  edge: 86400 * 365,      // 1 yıl edge cache (Cloudflare)
  staleWhileRevalidate: 86400 * 7  // 7 gün stale-while-revalidate
};

// In-flight requests map - Cache stampede protection
// Aynı URL için eşzamanlı istekleri tek bir fetch'e indirgeme
const inflightRequests = new Map();

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  
  try {
    const url = new URL(request.url);
    
    // Sadece GET ve HEAD isteklerini işle
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Health check endpoint
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response('x', { 
        status: 200,
        headers: { 
          'Content-Type': 'text/plain',
          'X-Powered-By': 'Cloudflare-Pages-CDN'
        }
      });
    }

    // Sadece .jpg uzantılı dosyalara izin ver
    const pathname = url.pathname.toLowerCase();
    if (!pathname.endsWith('.jpg') && !pathname.endsWith('.jpeg')) {
      return new Response('Forbidden', { 
        status: 403,
        headers: { 
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store'
        }
      });
    }

    // Referer kontrolü - Referer yoksa 403
    const referer = request.headers.get('referer') || request.headers.get('referrer');
    if (!referer) {
      return new Response('Forbidden', { 
        status: 403,
        headers: { 
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store'
        }
      });
    }

    // Cache key oluştur (URL + Range header)
    const rangeHeader = request.headers.get('range');
    const cacheKey = new Request(url.toString(), {
      method: 'GET',
      headers: rangeHeader ? { 'range': rangeHeader } : {}
    });

    // Cloudflare Cache API'sini kullan
    const cache = caches.default;
    
    // Cache'den kontrol et
    let response = await cache.match(cacheKey);
    
    if (response) {
      // Cache HIT - direkt dön
      const headers = new Headers(response.headers);
      headers.set('CF-Cache-Status', 'HIT');
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
    }

    // Cache MISS - Origin'den fetch et
    const originUrl = `${ORIGIN_URL}${url.pathname}${url.search}`;
    
    // Request Coalescing: Aynı URL için zaten bir fetch varsa onu bekle
    const cacheKeyString = cacheKey.url + (rangeHeader || '');
    let inflightPromise = inflightRequests.get(cacheKeyString);
    
    if (!inflightPromise) {
      // Yeni fetch başlat
      inflightPromise = (async () => {
        try {
          // Origin request headers
          const originHeaders = new Headers();
          
          // Range request varsa ilet (HLS için kritik)
          if (rangeHeader) {
            originHeaders.set('Range', rangeHeader);
          }
          
          // Diğer önemli headers
          const headersToProxy = [
            'accept',
            'accept-encoding',
            'user-agent',
            'if-none-match',
            'if-modified-since'
          ];
          
          headersToProxy.forEach(header => {
            const value = request.headers.get(header);
            if (value) originHeaders.set(header, value);
          });

          // Origin'e istek gönder
          const originResponse = await fetch(originUrl, {
            method: request.method,
            headers: originHeaders,
            cf: {
              // Cloudflare özel ayarları
              cacheTtl: CACHE_DURATION.edge,
              cacheEverything: true,
              polish: 'off',  // Görsel optimizasyonu kapalı (orijinal içeriği koru)
              minify: { javascript: false, css: false, html: false }
            }
          });
          
          return originResponse;
        } finally {
          // Fetch tamamlandı, map'ten temizle
          inflightRequests.delete(cacheKeyString);
        }
      })();
      
      // Map'e ekle (diğer istekler bu promise'i bekleyecek)
      inflightRequests.set(cacheKeyString, inflightPromise);
    }
    
    // Promise'i await et (ilk istek veya bekleyen istekler)
    const originResponse = await inflightPromise;

    // Origin başarısız olursa
    if (!originResponse.ok && originResponse.status !== 206 && originResponse.status !== 304) {
      return new Response(`Origin Error: ${originResponse.status}`, {
        status: originResponse.status,
        headers: {
          'Content-Type': 'text/plain',
          'X-Cache': 'ERROR',
          'Cache-Control': 'no-store'
        }
      });
    }

      // Yeni temiz headers oluştur (origin header'larını temizle)
      const responseHeaders = new Headers();
      
      // Content-Length (dosya boyutu - gerekli)
      const contentLength = originResponse.headers.get('content-length');
      if (contentLength) {
        responseHeaders.set('Content-Length', contentLength);
      }

      // Content-Range (partial content için - HLS'de gerekli)
      const contentRange = originResponse.headers.get('content-range');
      if (contentRange) {
        responseHeaders.set('Content-Range', contentRange);
      }
      
      // Aggressive caching headers
      if (originResponse.status === 200 || originResponse.status === 206) {
        responseHeaders.set('Cache-Control', 
          `public, max-age=${CACHE_DURATION.browser}, s-maxage=3600`
        );
        
        // ETag (origin'denkini kullan veya yeni oluştur)
        const etag = originResponse.headers.get('etag');
        if (etag) {
          responseHeaders.set('ETag', etag);
        } else {
          responseHeaders.set('ETag', `"${Date.now()}"`);
        }
        
        // Last-Modified (origin'denkini kullan veya yeni oluştur)
        const lastModified = originResponse.headers.get('last-modified');
        if (lastModified) {
          responseHeaders.set('Last-Modified', lastModified);
        } else {
          responseHeaders.set('Last-Modified', new Date().toUTCString());
        }
      }

      // CORS headers
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      responseHeaders.set('Access-Control-Max-Age', '86400');
      
      // Accept-Ranges (HLS için kritik)
      responseHeaders.set('Accept-Ranges', 'bytes');

      // Content-Type (her zaman image/jpeg)
      responseHeaders.set('Content-Type', 'image/jpeg');
      
      // Cache Status (MISS - origin'den geldi)
      responseHeaders.set('CF-Cache-Status', 'MISS');

    // Yeni response oluştur
    const newResponse = new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders
    });

    // Cache'e kaydet (sadece başarılı istekleri cache'le)
    if (originResponse.status === 200 || originResponse.status === 206) {
      // waitUntil ile cache'leme işlemini asenkron yap (response'u geciktirme)
      waitUntil(cache.put(cacheKey, newResponse.clone()));
    }

    return newResponse;

  } catch (error) {
    // Hata durumunda
    return new Response(`CDN Error: ${error.message}`, {
      status: 500,
      headers: {
        'Content-Type': 'text/plain',
        'X-Cache': 'ERROR',
        'Cache-Control': 'no-store'
      }
    });
  }
}
