// index.js - Végleges, stabil Node.js/Express Proxy Service

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

// KRITIKUS: A render.com használata esetén a protokoll automatikusan HTTPS-nek tekintendő.
const currentProxyDomain = process.env.PROXY_DOMAIN || 'render-bj2x.onrender.com'; 
const MAX_BODY_SIZE = '50mb';
const STANDARD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PROXY_HEADERS_TO_STRIP = [
    'x-powered-by', 'x-render-origin-server', 'via', 'connection', 
    'accept-encoding', 'forwarded', 'cf-connecting-ip', 
    'true-client-ip', 'x-forwarded-for', 'x-forwarded-proto', 
    'x-forwarded-port', 'transfer-encoding' 
];

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
 * JAVÍTÁS 4: Megszűri a proxy felé érkező request headereket,
 * és eltávolítja a problémás Referer fejlécet, majd helyette a céloldal Originjét küldi.
 */
function filterRequestHeaders(originalHeaders, targetURL) {
    const newHeaders = {};
    const lowerCaseHeadersToStrip = ALL_HEADERS_TO_STRIP.map(h => h.toLowerCase());
    const targetHost = targetURL.host;

    for (const [key, value] of Object.entries(originalHeaders)) {
        const lowerKey = key.toLowerCase();
        
        // KRITIKUS: Nem továbbítjuk a Host, Connection, Content-Length, és REFERER headereket!
        if (!['host', 'connection', 'content-length', 'referer'].includes(lowerKey) && 
            !lowerCaseHeadersToStrip.includes(lowerKey) && value) {
            newHeaders[key] = value;
        }
    }

    // Spoofolt headerek beállítása
    newHeaders['Host'] = targetHost;
    
    if (!newHeaders['user-agent']) {
        newHeaders['User-Agent'] = STANDARD_USER_AGENT;
    }

    // KRITIKUS JAVÍTÁS: A Referer fejléc az eredeti oldal origin-jét kell, hogy mutassa.
    newHeaders['Referer'] = targetURL.origin + '/'; 

    // Tubihoz is kellhet a kiegészítő Origin
    if (targetHost.includes('tubitv.com') || targetHost.includes('roku.com')) {
        newHeaders['Origin'] = targetURL.origin;
    }

    return newHeaders;
}

/**
 * JAVÍTÁS 1: Ellenőrzi és felülírja a Location headert, hogy az visszamutasson a proxyra.
 */
function rewriteLocationHeader(targetURL, responseHeaders, proxyDomain) {
    const locationHeader = responseHeaders.get('location');
    if (locationHeader) {
        const isRelative = !locationHeader.startsWith('http');
        const isTargetHost = locationHeader.includes(targetURL.host);

        if (isRelative || isTargetHost) {
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
 * KRITIKUS JAVÍTÁS: Kezeli a document.domain problémát (Roku) és stabilizálja az URL átírást.
 */
function rewriteHtmlContent(html, targetURL, proxyDomain) {
    const originalTargetOrigin = targetURL.origin;
    const originalTargetHost = targetURL.host; 
    
    // --- KRITIKUS JAVÍTÁS 1: document.domain semlegesítés (Roku fix) ---
    // Eltávolít minden document.domain = '...' hívást, ami SecurityError-t okoz
    let patchedHtml = html.replace(/document\.domain\s*=\s*['"][^'"]+['"];?/gi, (match) => {
        console.log(`[DOMAIN FIX] Removing dangerous script: ${match}`);
        return '/* document.domain beállítás letiltva a proxy által a SecurityError elkerülésére */';
    });
    
    // Ujra betöltjük a cheerio-ba a document.domain patch után
    const $ = cheerio.load(patchedHtml);

    const proxyPrefix = `https://${proxyDomain}/proxy?url=`;

    // --- KRITIKUS JAVÍTÁS 2: <base> tag bevezetése ---
    // Ez automatikusan kezeli a legtöbb relatív URL-t.
    const baseTag = `<base href="${originalTargetOrigin}/">`;
    if ($('head').length) {
        $('head').prepend(baseTag);
    } else {
        $('body').prepend(baseTag);
    }
    
    // --- KRITIKUS JAVÍTÁS 3: Kliensoldali Hálózati Hívás Interceptor ---
    // A Base tag miatt az interceptor csak az ABSZOLÚT URL-eket kezeli, amelyek a céloldalhoz tartoznak.
    const clientSidePatch = `
        <script>
            // Proxy Interceptor Script - Dinamikus hívások átirányítása
            (function() {
                const currentProxyHost = '${proxyDomain}';
                const originalTargetHost = '${originalTargetHost}';
                const proxyPrefix = 'https://' + currentProxyHost + '/proxy?url=';

                function resolveAndProxy(resource) {
                    let urlString = resource;
                    if (typeof urlString !== 'string') {
                        return resource;
                    }
                    
                    // Ha már proxyzva van, ne írjuk át újra
                    if (urlString.includes(currentProxyHost)) {
                        return urlString;
                    }
                    
                    // Abszolút URL-ek kezelése (ha a céloldalhoz tartozik)
                    // Az URL konstruktor használata a relatív/abszolút feloldásra, de a Base Tag már segített
                    try {
                        // A Base Tag miatt a relatív URL-ek már abszolútként viselkednek, 
                        // így csak az abszolút hívásokat kell átírni, amelyek a célhostot tartalmazzák.
                        const u = new URL(urlString, document.baseURI);
                        
                        if (u.hostname === originalTargetHost && u.protocol.startsWith('http')) {
                            return proxyPrefix + encodeURIComponent(u.href);
                        }
                    } catch (e) {
                        // Nem érvényes URL, hagyjuk figyelmen kívül
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
    
    // Patch beillesztése
    if ($('head').length) {
        $('head').append(clientSidePatch);
    } else {
        $('body').prepend(clientSidePatch);
    }

    // --- Statikus linkek átírása (HTML tag-ek) ---
    // A <base> tag bevezetése után már csak az abszolút URL-eket és a protokoll-relatív URL-eket kell átírni.
    $('a, link, script, img, source, meta').each((i, element) => {
        let attribute = '';
        const tag = $(element).prop('tagName').toLowerCase();

        if (tag === 'a' || tag === 'link' || $(element).attr('rel') === 'canonical') {
            attribute = 'href';
        } else if (tag === 'script' || tag === 'img' || tag === 'source') {
            attribute = 'src';
        } else if (tag === 'meta' && $(element).attr('content') && $(element).attr('content').includes('http')) {
            attribute = 'content';
        }

        if (attribute) {
            let originalUrl = $(element).attr(attribute);

            if (originalUrl) {
                // Protokoll-relatív URL-ek kezelése (//example.com/path)
                if (originalUrl.startsWith('//')) {
                    originalUrl = targetURL.protocol + originalUrl;
                }
                
                // Csak az abszolút URL-eket írjuk át, amelyek a céloldalhoz tartoznak
                try {
                    const absoluteUrl = new URL(originalUrl, originalTargetOrigin);
                    
                    if (absoluteUrl.hostname === originalTargetHost && absoluteUrl.protocol.startsWith('http')) {
                        const proxiedUrl = proxyPrefix + encodeURIComponent(absoluteUrl.href);
                        $(element).attr(attribute, proxiedUrl);
                    }
                } catch (e) {
                    // Nem érvényes URL, vagy a base tag kezeli
                }
            }
        }
    });


    return $.html();
}

/**
 * JAVÍTÁS 3: A kezdőlap stílusainak módosítása (szélesebb mező, nagyobb gomb).
 */
function getHomePage(proxyDomain) {
    return `
        <!DOCTYPE html>
        <html lang="hu">
        <head>
            <meta charset="UTF-8">
            <title>Web Proxy Kliens</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                /* JAVÍTOTT STÍLUSOK (Középre igazítás) */
                body {
                    display: flex;
                    flex-direction: column;
                    align-items: center; 
                    justify-content: center; 
                    min-height: 100vh;
                    margin: 0;
                    font-family: sans-serif;
                    background: #f4f4f4;
                    text-align: center;
                }
                h1 { color: #333; }
                form { 
                    background: white; 
                    padding: 30px; 
                    border-radius: 8px; 
                    box-shadow: 0 4px 8px rgba(0,0,0,0.1); 
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    width: 90%;
                    max-width: 600px;
                }
                input[type="text"] { 
                    width: 100%; 
                    padding: 15px; 
                    margin-bottom: 20px; 
                    border: 2px solid #ccc; 
                    border-radius: 6px; 
                    font-size: 18px; 
                    box-sizing: border-box;
                }
                button { 
                    padding: 15px 40px; 
                    background: #007bff; 
                    color: white; 
                    border: none; 
                    border-radius: 6px; 
                    cursor: pointer; 
                    font-size: 20px; 
                    transition: background 0.3s;
                }
                button:hover { background: #0056b3; }
                p.info { margin-top: 20px; font-size: 0.9em; color: #666; }
            </style>
            <script>
                function redirectToProxy(event) {
                    event.preventDefault();
                    const targetUrl = document.getElementById('targetUrl').value.trim();
                    if (targetUrl) {
                        // Kiegészíti a protokollal, ha hiányzik
                        const fullUrl = targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl;
                        window.location.href = '/proxy?url=' + encodeURIComponent(fullUrl);
                    }
                }
            </script>
        </head>
        <body>
            <h1>Web Proxy Kliens Aktív</h1>
            <p>Írja be a cél URL-t a böngészés elindításához:</p>
            <form onsubmit="redirectToProxy(event)">
                <input type="text" id="targetUrl" placeholder="Pl: https://tubitv.com vagy therokuchannel.roku.com">
                <button type="submit">Proxy Go</button>
            </form>
            <p class="info">Proxy domain: <code>https://${proxyDomain}</code></p>
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

        // B) Stray Asset Átirányítás (404 FIX)
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

            if (proxyQueryKeys.length > 0) {
                const extraParams = new URLSearchParams();
                proxyQueryKeys.forEach(key => {
                    extraParams.append(key, req.query[key]);
                });
                
                // Hozzáadja a query paramétereket a cél URL-hez
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
        
        const fetchHeaders = filterRequestHeaders(req.headers, targetURL); 
        
        const fetchOptions = {
            method: req.method,
            headers: fetchHeaders,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
            redirect: 'manual', // Fontos a Location header manuális kezeléséhez
            timeout: 15000 // 15 másodperc timeout
        };
        
        const response = await fetch(targetURL.href, fetchOptions);

        // --- VÁLASZ ELŐKÉSZÍTÉSE ÉS Továbbítás ---

        const newRespHeaders = new Headers(response.headers);
        const contentType = newRespHeaders.get('content-type') || ''; 
        
        // JAVÍTÁS 1: Átirányítási (Location) fejlécek felülírása
        rewriteLocationHeader(targetURL, newRespHeaders, currentProxyDomain);

        // KRITIKUS FEJLÉCEK TÖRLÉSE ÉS KÖTELEZŐ CORS BEÁLLÍTÁS MINDEN VÁLASZ ESETÉN! (Tubi fix)
        newRespHeaders.delete('content-encoding'); 
        newRespHeaders.delete('content-security-policy'); 
        newRespHeaders.delete('x-frame-options');
        newRespHeaders.delete('x-content-type-options'); 
        newRespHeaders.delete('x-render-origin-server');
        newRespHeaders.delete('x-powered-by');
        newRespHeaders.set('access-control-allow-origin', '*'); 

        // Fejlécek továbbítása
        res.status(response.status);

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
            // Itt ne állítsuk be a Content-Length-et, mivel a tartalom mérete megváltozott
            res.status(response.status).send(rewrittenHtml);
            
        } else {
            // B) MINDEN MÁS TARTALOM (JS, CSS, Képek, videók, stb.) - stream
            
            res.setHeader('Content-Type', contentType); 

            const contentLength = newRespHeaders.get('content-length');
            if (contentLength) {
                res.setHeader('Content-Length', contentLength);
            }
            console.log(`Streaming ${contentType} for: ${targetURL.href}`);
            
            // Az eredeti adatfolyam streamelése
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
