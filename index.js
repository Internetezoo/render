// index.js - Végleges, stabil Node.js/Express Proxy Service (Javított Tubi 400 és Roku Redirect fix-szel)

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio'); 
const url = require('url'); 
const cors = require('cors'); 

const app = express();
const PORT = process.env.PORT || 3000; 

// ===============================================
// 1. KONFIGURÁCIÓ ÉS ÁLLANDÓK
// ===============================================

const currentProxyDomain = process.env.PROXY_DOMAIN || 'render-bj2x.onrender.com'; 
const MAX_BODY_SIZE = '50mb';
const STANDARD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Proxy azonosító headerek, amiket el kell távolítani a 403-as hiba elkerülésére (Render, Express, stb.)
const PROXY_HEADERS_TO_STRIP = [
    'x-powered-by', 'x-render-origin-server', 'via', 'connection', 
    'accept-encoding', 'forwarded', 'cf-connecting-ip', 
    'true-client-ip', 'x-forwarded-for', 'x-forwarded-proto', 
    'x-forwarded-port', 'transfer-encoding' 
];

// Tubi Autentikációs headerek, amik 400 hibát okoznak, és el kell távolítani
const TUBI_AUTH_HEADERS_TO_STRIP = [
    'x-tubi-algorithm', 'x-tubi-date', 'x-tubi-expires',
    'x-tubi-signedheaders', 'x-tubi-signature'
];

const ALL_HEADERS_TO_STRIP = [
    ...PROXY_HEADERS_TO_STRIP,
    ...TUBI_AUTH_HEADERS_TO_STRIP
];

// Middleware a body-k és CORS kezeléséhez
app.use(cors());
app.use(express.raw({ type: '*/*', limit: MAX_BODY_SIZE }));

// ===============================================
// 2. KRITIKUS FEJLÉC SZŰRŐ ÉS JAVÍTÓ FUNKCIÓK
// ===============================================

/**
 * Szűri a bejövő headereket, eltávolítva a blokkolt biztonsági és
 * a proxy használatára utaló headereket.
 */
function filterRequestHeaders(originalHeaders, targetHost) {
    const newHeaders = {};
    const lowerCaseHeadersToStrip = ALL_HEADERS_TO_STRIP.map(h => h.toLowerCase());

    for (const [key, value] of Object.entries(originalHeaders)) {
        if (!['host', 'connection', 'content-length'].includes(key.toLowerCase()) && 
            !lowerCaseHeadersToStrip.includes(key.toLowerCase()) && value) {
            newHeaders[key] = value;
        }
    }

    newHeaders['Host'] = targetHost;
    
    if (!newHeaders['user-agent']) {
        newHeaders['User-Agent'] = STANDARD_USER_AGENT;
    }

    newHeaders['Referer'] = `https://${targetHost}/`; 
    
    return newHeaders;
}

/**
 * JAVÍTÁS 1: Ellenőrzi és felülírja a Location headert, hogy az visszamutasson a proxyra.
 */
function rewriteLocationHeader(targetURL, responseHeaders, proxyDomain) {
    const locationHeader = responseHeaders.get('location');
    if (locationHeader) {
        // Ellenőrizzük, hogy az átirányítás a cél domainre (vagy relatív útvonalra) mutat-e
        const isRelative = !locationHeader.startsWith('http');
        const isTargetHost = locationHeader.includes(targetURL.host);

        if (isRelative || isTargetHost) {
            // A location.resolve a relatív/abszolút útvonalakat is helyesen kezeli
            const absoluteUrl = url.resolve(targetURL.href, locationHeader);
            const proxiedUrl = `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
            
            responseHeaders.set('location', proxiedUrl);
            return true;
        }
    }
    return false;
}


// ===============================================
// 3. HTML TARTALOM ÁTÍRÓ ÉS INJEKTOR
// ===============================================

/**
 * Átírja a HTML tartalomban lévő URL-eket a proxy domainjére és INJEKTÁLJA A JS INTERCEPTORT.
 */
function rewriteHtmlContent(html, targetURL, proxyDomain) {
    const $ = cheerio.load(html);
    
    const proxyPrefix = `https://${proxyDomain}/proxy?url=`;
    const originalTargetOrigin = targetURL.origin;

    // --- KRITIKUS JAVÍTÁS: Kliensoldali Hálózati Hívás Interceptor ---
    const clientSidePatch = `
        <script>
            // Proxy Interceptor Script - Dinamikus hívások átirányítása
            (function() {
                // ROKU FIX 1: Eltávolítjuk a document.domain hozzárendeléseket a SecurityError elkerülése érdekében
                try {
                    // Megkerüljük a document.domain beállítást
                    const domainRegex = /document\\.domain\\s*=\\s*['"].*?['"]/g;
                    if (document.documentElement && document.documentElement.innerHTML) {
                        document.documentElement.innerHTML = document.documentElement.innerHTML.replace(domainRegex, '/* document.domain assignment removed by proxy */');
                    }
                } catch (e) {
                    console.error("Proxy: document.domain removal failed", e);
                }

                const currentProxyDomain = '${proxyDomain}';
                const originalTargetHost = '${targetURL.host}';
                const proxyPrefix = '${proxyPrefix}';


                function resolveAndProxy(resource) {
                    let urlString = resource;
                    if (typeof urlString !== 'string') {
                        return resource;
                    }
                    
                    if (urlString.includes(currentProxyDomain) && urlString.includes('/proxy?url=')) {
                        return urlString;
                    }
                    
                    // Relatív/Gyökér-relatív URL-ek kezelése
                    if (urlString.startsWith('/') && !urlString.startsWith('//')) {
                        const absoluteUrl = originalTargetOrigin + urlString;
                        return proxyPrefix + encodeURIComponent(absoluteUrl);
                    }
                    
                    // Abszolút URL-ek kezelése (ha a céloldalhoz tartozik)
                    if (urlString.startsWith('http') && urlString.includes(originalTargetHost)) {
                        return proxyPrefix + encodeURIComponent(urlString);
                    }
                    
                    return resource;
                }
                
                // Fetch lehallgatása
                const originalFetch = window.fetch;
                window.fetch = function(resource, options) {
                    const proxiedResource = resolveAndProxy(resource);
                    return originalFetch(proxiedResource, options);
                };

                // XHR lehallgatása
                const originalXhrOpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                    const proxiedUrl = resolveAndProxy(url);
                    originalXhrOpen.call(this, method, proxiedUrl, async, user, password);
                };
            })();
        </script>
    `;

    if ($('head').length) {
        $('head').prepend(clientSidePatch);
    } else {
        $('body').prepend(clientSidePatch);
    }
    
    // --- Statikus linkek átírása (HTML tag-ek) ---
    $('a, link, script, img, source, meta').each((i, element) => {
        let attribute = '';
        if (element.tagName === 'a' || element.tagName === 'link') {
            attribute = 'href';
        } else if (element.tagName === 'script' || element.tagName === 'img' || element.tagName === 'source') {
            attribute = 'src';
        } else if (element.tagName === 'meta' && $(element).attr('content') && $(element).attr('content').includes('http')) {
            attribute = 'content';
        }

        if (attribute) {
            let originalUrl = $(element).attr(attribute);

            if (originalUrl) {
                
                if (originalUrl.startsWith('/') && !originalUrl.startsWith('//')) {
                    const absoluteUrl = targetURL.origin + originalUrl;
                    const proxiedUrl = proxyPrefix + encodeURIComponent(absoluteUrl);
                    $(element).attr(attribute, proxiedUrl);
                    return; 
                }

                const absoluteUrl = url.resolve(targetURL.href, originalUrl);
                
                if (absoluteUrl.startsWith('http') && absoluteUrl.includes(targetURL.host)) {
                    const proxiedUrl = proxyPrefix + encodeURIComponent(absoluteUrl);
                    $(element).attr(attribute, proxiedUrl);
                }
            }
        }
    });

    return $.html();
}

function getHomePage(proxyDomain) {
    // A kezdőoldal logikája változatlan
    return `
        <!DOCTYPE html>
        <html lang="hu">
        <head>
            <meta charset="UTF-8">
            <title>Web Proxy Kliens</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { font-family: sans-serif; margin: 50px; background: #f4f4f4; }
                h1 { color: #333; }
                form { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
                input[type="text"] { width: 80%; padding: 10px; margin-right: 10px; border: 1px solid #ccc; border-radius: 4px; }
                button { padding: 10px 15px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
                button:hover { background: #0056b3; }
                p.info { margin-top: 20px; font-size: 0.9em; color: #666; }
            </style>
        </head>
        <body>
            <h1>Web Proxy Kliens Aktív</h1>
            <p>Használja az alábbi mezőt a proxyzott URL eléréséhez:</p>
            <form onsubmit="redirectToProxy(event)">
                <input type="text" id="targetUrl" placeholder="Írja be a cél URL-t (pl. https://tubitv.com)">
                <button type="submit">Proxy Go</button>
            </form>
            <p class="info">Proxy domain: <code>https://${proxyDomain}</code></p>
            <script>
                function redirectToProxy(event) {
                    event.preventDefault();
                    const targetUrl = document.getElementById('targetUrl').value;
                    if (targetUrl) {
                        const fullUrl = targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl;
                        window.location.href = '/proxy?url=' + encodeURIComponent(fullUrl);
                    }
                }
            </script>
        </body>
        </html>
    `;
}


// ===============================================
// 4. FŐ PROXY KEZELŐ FÜGGVÉNY
// ===============================================

app.all('*', async (req, res) => {
    try {
        let targetURL;

        // A) Kezdőoldal kezelése
        if (req.path === '/' && !req.query.url) {
            return res.status(200).type('text/html').send(getHomePage(currentProxyDomain));
        }

        // B) Stray Asset Átirányítás (FIX android-chrome-144x144.png 404-re)
        const isStrayAsset = req.path.includes('/api/') || req.path.includes('/s/') || req.path.includes('/v1/') ||
                             req.path.endsWith('.js') || req.path.endsWith('.json') || 
                             req.path.endsWith('.css') || req.path.endsWith('.m3u8') || 
                             req.path.endsWith('.png') || req.path.endsWith('.ico') || req.path.endsWith('.webmanifest'); 

        if (req.path !== '/proxy' && req.headers['referer'] && isStrayAsset) {
            
            const referrer = req.headers['referer'];
            let assumedTargetOrigin = ''; 

            try {
                const referrerUrl = new URL(referrer);
                if (referrerUrl.hostname === currentProxyDomain) {
                    const originalUrlParam = referrerUrl.searchParams.get('url');
                    if (originalUrlParam) {
                        const originalUrl = new URL(originalUrlParam);
                        assumedTargetOrigin = originalUrl.origin;
                    }
                }
            } catch(e) { /* Hiba figyelmen kívül hagyása */ }
            
            if (assumedTargetOrigin) {
                const absoluteTargetUrl = assumedTargetOrigin + req.path;
                const correctProxyUrl = `/proxy?url=${encodeURIComponent(absoluteTargetUrl)}`;
                
                console.log(`REDIRECTING STRAY ASSET: ${req.path} -> ${correctProxyUrl}`);
                return res.redirect(302, correctProxyUrl);
            }
        }
        
        // C) A fő proxy logika: /proxy?url=...
        if (req.path === '/proxy' && req.query.url) {
            let fullTargetUrl = req.query.url;
            const proxyQueryKeys = Object.keys(req.query).filter(key => key !== 'url');

            // KRITIKUS JAVÍTÁS (V4): Hozzáadjuk a proxyhoz küldött, de a céloldalnak szánt extra query paramétereket (pl. Tubi auth)
            if (proxyQueryKeys.length > 0) {
                const extraParams = new URLSearchParams();
                proxyQueryKeys.forEach(key => {
                    extraParams.append(key, req.query[key]);
                });
                
                fullTargetUrl += (fullTargetUrl.includes('?') ? '&' : '?') + extraParams.toString();
            }
            
            targetURL = new URL(fullTargetUrl);
            
        } else {
            if (!res.headersSent) {
                return res.status(404).send('404 Not Found. Használja a /proxy?url=... formátumot.');
            }
            return;
        }

        console.log(`Proxying request for: ${targetURL.href}`);

        // --- PROXY KÉRÉS ELKÜLDÉSE (fetch) ---

        const fetchHeaders = filterRequestHeaders(req.headers, targetURL.host);
        
        const fetchOptions = {
            method: req.method,
            headers: fetchHeaders,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
            redirect: 'manual', // Fontos: manuálisan kell kezelni az átirányításokat a Location fejlécben
            timeout: 15000 
        };
        
        const response = await fetch(targetURL.href, fetchOptions);

        // --- VÁLASZ ELŐKÉSZÍTÉSE ÉS Továbbítás ---

        const newRespHeaders = new Headers(response.headers);
        const contentType = newRespHeaders.get('content-type') || ''; 
        
        // ** JAVÍTÁS 1: Átirányítási (Location) fejlécek felülírása **
        // Ha van átirányítás, a böngésző visszatér a proxyhoz
        rewriteLocationHeader(targetURL, newRespHeaders, currentProxyDomain);

        // KRITIKUS FEJLÉCEK TÖRLÉSE ÉS KÖTELEZŐ CORS BEÁLLÍTÁS MINDEN VÁLASZ ESETÉN!
        newRespHeaders.delete('content-encoding'); 
        newRespHeaders.delete('content-security-policy'); 
        newRespHeaders.delete('x-frame-options');
        newRespHeaders.delete('x-content-type-options'); 
        newRespHeaders.delete('x-render-origin-server');
        newRespHeaders.delete('x-powered-by');
        newRespHeaders.set('access-control-allow-origin', '*'); 

        newRespHeaders.forEach((value, name) => {
            if (name.toLowerCase() !== 'content-length' && 
                !ALL_HEADERS_TO_STRIP.includes(name.toLowerCase())) { 
                res.setHeader(name, value);
            }
        });
        
        // A) HTML ESET: Átírás és küldés
        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
            console.log(`Handling HTML for: ${targetURL.href}`);
            const htmlText = await response.text();
            
            const rewrittenHtml = rewriteHtmlContent(htmlText, targetURL, currentProxyDomain); 
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8'); 
            res.status(response.status).send(rewrittenHtml);
            
        } else {
            // ** JAVÍTÁS 2: Eltávolítottuk az agresszív JS/CSS string cserét. **
            // B) MINDEN MÁS TARTALOM (JS, CSS, Képek, videók, stb.) - stream
            
            res.setHeader('Content-Type', contentType); 
            res.status(response.status);

            // Content-Length beállítása, ha létezik, a streameléshez
            const contentLength = newRespHeaders.get('content-length');
            if (contentLength) {
                res.setHeader('Content-Length', contentLength);
            }
            console.log(`Streaming ${contentType} for: ${targetURL.href}`);
            
            response.body.pipe(res);

            response.body.on('error', (err) => {
                console.error('Stream error:', err);
                if (!res.headersSent) {
                    res.status(502).end();
                }
            });
        }

    } catch (error) {
        console.error(`PROXY CRITICAL ERROR for ${req.url}:`, error.message);
        
        if (!res.headersSent) {
             res.status(502).type('text/plain').send(`PROXY HÁLÓZATI VAGY BELSŐ HIBA (502): ${error.message}.`);
        }
    }
});


// ===============================================
// 5. SZERVER INDÍTÁSA
// ===============================================

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Proxy domain: ${currentProxyDomain}`);
});
