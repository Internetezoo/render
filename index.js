// index.js - Végleges, stabil Node.js/Express Proxy Service (Javított fejlécekkel és CORS/Roku fix-szel)

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio'); // HTML tartalom elemzéséhez és módosításához
const url = require('url'); // URL feloldáshoz
const cors = require('cors'); // CORS problémák kezeléséhez

const app = express();
const PORT = process.env.PORT || 3000; 

// ===============================================
// 1. KONFIGURÁCIÓ ÉS ÁLLANDÓK
// ===============================================

const currentProxyDomain = process.env.PROXY_DOMAIN || 'render-bj2x.onrender.com'; // Feltevések a jelenlegi Render domainről
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

// Kombinált lista
const ALL_HEADERS_TO_STRIP = [
    ...PROXY_HEADERS_TO_STRIP,
    ...TUBI_AUTH_HEADERS_TO_STRIP
];

// Middleware a body-k és CORS kezeléséhez
app.use(cors());
app.use(express.raw({ type: '*/*', limit: MAX_BODY_SIZE })); // Nyers test (body) fogadása minden típusú kéréshez


// ===============================================
// 2. KRITIKUS FEJLÉC SZŰRŐ FUNKCIÓ (FIX 400/403)
// ===============================================

/**
 * Szűri a bejövő headereket, eltávolítva a blokkolt biztonsági és
 * a proxy használatára utaló headereket. Ez a 400 és 403 hibák kulcsa.
 * * @param {object} originalHeaders - Az eredeti bejövő headerek (Express req.headers).
 * @param {string} targetHost - A célállomás hostneve (pl. tubitv.com).
 * @returns {object} A Tubi felé továbbítandó tiszta headerek.
 */
function filterRequestHeaders(originalHeaders, targetHost) {
    const newHeaders = {};
    const lowerCaseHeadersToStrip = ALL_HEADERS_TO_STRIP.map(h => h.toLowerCase());

    // 1. Az összes érvényes kérés fejléc másolása, kivéve a blokkoltakat
    for (const [key, value] of Object.entries(originalHeaders)) {
        // Kizárjuk a Host és Content-Length fejléceket, hogy a fetch tudja használni a targetURL host-ját
        if (!['host', 'connection', 'content-length'].includes(key.toLowerCase()) && 
            !lowerCaseHeadersToStrip.includes(key.toLowerCase()) && value) {
            newHeaders[key] = value;
        }
    }

    // 2. KRITIKUS BEÁLLÍTÁSOK A BLOKKOLÁS ELKERÜLÉSÉRE
    
    // A cél Host fejlécének beállítása (ez kell a Tubi-nak/Roku-nak a 403 elkerülésére)
    newHeaders['Host'] = targetHost;
    
    // User-Agent: ha van, továbbítjuk; ha nincs, standard böngésző User-Agent-et állítunk be.
    if (!newHeaders['user-agent']) {
        newHeaders['User-Agent'] = STANDARD_USER_AGENT;
    }

    // Referer fejléc felülírása a cél domainre
    newHeaders['Referer'] = `https://${targetHost}/`; 
    
    return newHeaders;
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
    // Ez a script fogja elkapni a JS-ből indított fetch/XHR hívásokat
    const clientSidePatch = `
        <script>
            // Proxy Interceptor Script - Dinamikus hívások átirányítása
            (function() {
                // ROKU FIX 1: Eltávolítjuk a document.domain hozzárendeléseket a SecurityError elkerülése érdekében
                try {
                    const domainRegex = /document\\.domain\\s*=\\s*['"].*?['"]/g;
                    document.documentElement.innerHTML = document.documentElement.innerHTML.replaceAll(domainRegex, '/* document.domain assignment removed by proxy */');
                } catch (e) {
                    console.error("Proxy: document.domain removal failed", e);
                }

                const proxyPrefix = '${proxyPrefix}';
                const currentProxyDomain = '${proxyDomain}';
                const originalTargetOrigin = '${originalTargetOrigin}';

                function resolveAndProxy(resource) {
                    let urlString = resource;
                    if (typeof urlString !== 'string') {
                        return resource;
                    }
                    
                    // 1. Ha már proxizva van, hagyjuk békén
                    if (urlString.includes(currentProxyDomain) && urlString.includes('/proxy?url=')) {
                        return urlString;
                    }
                    
                    // 2. Gyökér-relatív URL-ek kezelése (/api/..., /s/...)
                    if (urlString.startsWith('/')) {
                        // Különböző origin feloldás szükséges
                        const absoluteUrl = originalTargetOrigin + urlString;
                        return proxyPrefix + encodeURIComponent(absoluteUrl);
                    }
                    
                    // 3. Abszolút URL-ek kezelése (ha a céloldalhoz tartozik)
                    if (urlString.startsWith('http') && urlString.includes(targetURL.host)) {
                        return proxyPrefix + encodeURIComponent(urlString);
                    }
                    
                    // Más (külső) URL-eket érintetlenül hagyunk
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

    // Injektálás a <head> elejére
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
                
                // Gyökér-relatív linkek kezelése (pl.: /css/style.css)
                if (originalUrl.startsWith('/') && !originalUrl.startsWith('//')) {
                    const absoluteUrl = targetURL.origin + originalUrl;
                    const proxiedUrl = `https://${proxyDomain}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                    $(element).attr(attribute, proxiedUrl);
                    return; 
                }

                // Abszolút linkek kezelése (ha a céloldal domainjére mutat)
                const absoluteUrl = url.resolve(targetURL.href, originalUrl);
                
                if (absoluteUrl.startsWith('http') && absoluteUrl.includes(targetURL.host)) {
                    const proxiedUrl = `https://${proxyDomain}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                    $(element).attr(attribute, proxiedUrl);
                }
            }
        }
    });

    return $.html();
}


/**
 * Generálja az egyszerű kezdőoldalt.
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

        // B) Stray Asset Átirányítás (ha egy kliens oldali forrás a gyökérhez viszonyítva kér valamit)
        const isStrayAsset = req.path.includes('/api/') || req.path.includes('/s/') || req.path.includes('/v1/') ||
                             req.path.endsWith('.js') || req.path.endsWith('.json') || 
                             req.path.endsWith('.css') || req.path.endsWith('.m3u8');

        if (req.path !== '/proxy' && req.headers['referer'] && isStrayAsset) {
            
            const referrer = req.headers['referer'];
            let assumedTargetOrigin = ''; 

            try {
                const referrerUrl = new URL(referrer);
                // Csak akkor feltételezzük, hogy az eredeti forrásra vonatkozik, ha a referer a mi proxy domainünk
                if (referrerUrl.hostname === currentProxyDomain) {
                    const originalUrlParam = referrerUrl.searchParams.get('url');
                    if (originalUrlParam) {
                        const originalUrl = new URL(originalUrlParam);
                        assumedTargetOrigin = originalUrl.origin;
                    }
                }
            } catch(e) { /* Hiba figyelmen kívül hagyása */ }
            
            if (assumedTargetOrigin) {
                // Relatív útvonalat abszolút URL-re konvertálunk és proxyn keresztül irányítjuk át
                const absoluteTargetUrl = assumedTargetOrigin + req.path;
                const correctProxyUrl = `/proxy?url=${encodeURIComponent(absoluteTargetUrl)}`;
                
                console.log(`REDIRECTING STRAY ASSET: ${req.path} -> ${correctProxyUrl}`);
                return res.redirect(302, correctProxyUrl);
            }
        }
        
        // C) A fő proxy logika: /proxy?url=...
        if (req.path === '/proxy' && req.query.url) {
            targetURL = new URL(req.query.url);
        } else {
            if (!res.headersSent) {
                return res.status(404).send('404 Not Found. Használja a /proxy?url=... formátumot.');
            }
            return;
        }

        console.log(`Proxying request for: ${targetURL.href}`);

        // --- PROXY KÉRÉS ELKÜLDÉSE (fetch) ---

        // 🛑 KRITIKUS JAVÍTÁS: Fejlécek szűrése és beállítása
        const fetchHeaders = filterRequestHeaders(req.headers, targetURL.host);
        
        // A kérés törzsének (body) kezelése
        const fetchOptions = {
            method: req.method,
            headers: fetchHeaders,
            // Csak POST/PUT/PATCH kérés esetén küldjük a body-t
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
        };
        
        const response = await fetch(targetURL.href, fetchOptions);

        // --- VÁLASZ ELŐKÉSZÍTÉSE ÉS Továbbítás ---

        // Válasz headerek szűrése és beállítása
        const newRespHeaders = new Headers(response.headers);
        const contentType = newRespHeaders.get('content-type') || ''; 

        // KRITIKUS FEJLÉCEK TÖRLÉSE ÉS KÖTELEZŐ CORS BEÁLLÍTÁS MINDEN VÁLASZ ESETÉN!
        newRespHeaders.delete('content-encoding'); // Fontos, ha nem szeretnénk decompressálni a fetch-hel.
        newRespHeaders.delete('content-security-policy'); // A böngésző tiltólistájának felülírása
        newRespHeaders.delete('x-frame-options');
        newRespHeaders.delete('x-content-type-options'); 
        newRespHeaders.delete('x-render-origin-server'); // Proxy adatok törlése a válaszból
        newRespHeaders.delete('x-powered-by');
        newRespHeaders.set('access-control-allow-origin', '*'); // Ezzel fixáljuk a CORS problémákat

        // Minden más fejléceket másolunk
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
            
            // Itt fut le a Roku document.domain eltávolítása is, és a statikus linkek cseréje
            const rewrittenHtml = rewriteHtmlContent(htmlText, targetURL, currentProxyDomain); 
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8'); 
            res.status(response.status).send(rewrittenHtml);
            
        // B) JAVASCRIPT/CSS/JSON ESET: Tartalom átírása
        } else if (contentType.includes('javascript') || contentType.includes('css') || contentType.includes('json')) {
             console.log(`Rewriting ${contentType} content for: ${targetURL.href}`);
            const textContent = await response.text();
            
            const proxiedOriginPrefix = `https://${currentProxyDomain}/proxy?url=`;
            let rewrittenContent = textContent;

            // FIX 2: Tubi Fontok CORS-hiba javítása (aggresszív domain csere a forráskódon belül)
            // Közvetlenül a CDN/API domaineket cseréljük proxizott linkre, hogy a JS/CSS-ben lévő hívások is átmenjenek a proxyn
            if (targetURL.hostname.includes('tubitv.com')) {
                const tubiDomains = [
                    'https://md0.tubitv.com',
                    'https://mcdn.tubitv.com',
                    'https://account.production-public.tubi.io',
                    'https://tensor-cdn.production-public.tubi.io'
                ];
                
                tubiDomains.forEach(domain => {
                    rewrittenContent = rewrittenContent.replaceAll(domain, proxiedOriginPrefix + encodeURIComponent(domain));
                });
            }

            // Roku asset domainek cseréje
            if (targetURL.hostname.includes('roku.com')) {
                 const targetOrigin = targetURL.origin;
                 rewrittenContent = rewrittenContent.replaceAll(targetOrigin, proxiedOriginPrefix + targetOrigin);
            }
            
            res.setHeader('Content-Type', contentType); 
            res.status(response.status).send(rewrittenContent);

        } else {
            // C) MINDEN MÁS TARTALOM (Képek, videók, stb.) - stream
            
            res.setHeader('Content-Type', contentType); 

            console.log(`Streaming ${contentType} for: ${targetURL.href}`);
            res.status(response.status);
            
            // Válasz body streamelése a kliens felé
            response.body.pipe(res);

            response.body.on('error', (err) => {
                console.error('Stream error:', err);
                if (!res.headersSent) {
                    res.status(502).end();
                }
            });
        }

    } catch (error) {
        // Globális Hiba Kezelés (502-t ad vissza)
        console.error(`PROXY CRITICAL ERROR for ${req.url}:`, error.message);
        
        if (!res.headersSent) {
             res.status(502).type('text/plain').send(`PROXY HÁLÓZATI VAGY BELSŐ HIBA (502): ${error.message}. Kérem, ellenőrizze a céloldal elérhetőségét.`);
        }
    }
});


// ===============================================
// 5. SZERVER INDÍTÁSA
// ===============================================

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Proxy domain feltételezve: ${currentProxyDomain}`);
});
