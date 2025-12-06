// index.js - Végleges, stabil Node.js/Express Proxy Service (Javított fejlécekkel és CORS/Roku fix-szel)

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000; 

// ===============================================
// 1. KONFIGURÁCIÓ
// ===============================================

const currentProxyDomain = process.env.PROXY_DOMAIN || 'localhost:3000';

// Nyers test (body) fogadása minden típusú kéréshez (POST/PUT/stb.)
app.use(express.raw({ type: '*/*' }));

// ===============================================
// 2. FUNKCIÓK
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
            (function() {
                // ROKU FIX 1: Eltávolítjuk a document.domain hozzárendeléseket, hogy elkerüljük a SecurityError-t
                try {
                    // Célzott eltávolítás
                    const domainRegex = /document\\.domain\\s*=\\s*['"].*?['"]/g;
                    document.documentElement.innerHTML = document.documentElement.innerHTML.replaceAll(domainRegex, '/* document.domain assignment removed by proxy */');
                } catch (e) {
                    // Ha nem sikerül, nem állunk le
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
                    
                    // 1. Abszolút URL-ek kezelése
                    if (urlString.startsWith('http')) {
                        // Ha már proxizva van, hagyjuk békén
                        if (urlString.includes(currentProxyDomain)) {
                            return urlString;
                        }
                        return proxyPrefix + encodeURIComponent(urlString);
                    }
                    
                    // 2. Gyökér-relatív URL-ek kezelése (/api/..., /s/..., /sw.js)
                    if (urlString.startsWith('/')) {
                        const absoluteUrl = originalTargetOrigin + urlString;
                        return proxyPrefix + encodeURIComponent(absoluteUrl);
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
                
                // Gyökér-relatív linkek kezelése
                if (originalUrl.startsWith('/') && !originalUrl.startsWith('//')) {
                    const absoluteUrl = targetURL.origin + originalUrl;
                    const proxiedUrl = `https://${proxyDomain}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                    $(element).attr(attribute, proxiedUrl);
                    return; 
                }

                // Abszolút linkek kezelése
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
 * Generálja az egyszerű kezdőoldalt. (omitted)
 */
function getHomePage(proxyDomain) {
    return `
        <!DOCTYPE html>
        <html lang="hu">
        <head>
            <meta charset="UTF-8">
            <title>Egyszerű Node.js Proxy</title>
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
            <h1>Web Proxy Kliens</h1>
            <form onsubmit="redirectToProxy(event)">
                <input type="text" id="targetUrl" placeholder="Írja be a cél URL-t (pl. https://example.com)">
                <button type="submit">Proxy Go</button>
            </form>
            <p class="info">Ez a proxy: <code>https://${proxyDomain}</code></p>
            <p class="info">Közvetlen API teszt: <a href="/proxy?url=https://api.myip.com/">/proxy?url=https://api.myip.com/</a></p>
            
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
// 3. FŐ ÚTVONAL KEZELŐ (Route Handler)
// ===============================================

app.all('*', async (req, res) => {
    try {
        let targetURL;

        // A) Kezdőoldal: /
        if (req.path === '/' && !req.query.url) {
            return res.status(200).type('text/html').send(getHomePage(currentProxyDomain));
        }

        // KRITIKUS JAVÍTÁS (Agresszív Asset Átirányítás)
        const isStrayPath = req.path.includes('/api/') || 
                            req.path.includes('/s/') || 
                            req.path.endsWith('.js') ||
                            req.path.endsWith('.json') ||
                            req.path.endsWith('.mp4') ||
                            req.path.endsWith('service-worker.js') ||
                            req.path.endsWith('sw.js') ||
                            req.path.endsWith('manifest.json');

        if (req.path !== '/proxy' && req.headers['referer'] && isStrayPath) {
            
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
            } catch(e) { console.error("Referer parsing error:", e.message); }
            
            if (assumedTargetOrigin) {
                const absoluteTargetUrl = assumedTargetOrigin + req.path;
                const correctProxyUrl = `/proxy?url=${encodeURIComponent(absoluteTargetUrl)}`;
                
                console.log(`REDIRECTING STRAY ASSET: ${req.path} -> ${correctProxyUrl}`);
                return res.redirect(302, correctProxyUrl);
            }
        }
        
        // B) A fő proxy logika: /proxy?url=...
        if (req.path === '/proxy' && req.query.url) {
            targetURL = new URL(req.query.url);
        } else {
            if (!res.headersSent) {
                return res.status(404).send('Not Found or Invalid Proxy URL Format. Használja a /proxy?url=... formátumot.');
            }
            return;
        }

        console.log(`Proxying request for: ${targetURL.href}`);

        // --- PROXY KÉRÉS ELKÜLDÉSE (fetch) ---

        // 🛑 KRITIKUS JAVÍTÁS: Minden bejövő fejléc továbbítása, kivéve az ütközőket
        const fetchHeaders = {};
        Object.keys(req.headers).forEach(key => {
            // Kizárjuk a Host, Connection, Content-Length fejléceket, hogy a fetch tudja használni a targetURL host-ját
            if (!['host', 'connection', 'content-length'].includes(key.toLowerCase())) {
                fetchHeaders[key] = req.headers[key];
            }
        });

        // Felülírjuk a User-Agent-et, Referer-t, Host-ot, hogy a céloldal felé helyesnek tűnjön
        fetchHeaders['User-Agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36';
        fetchHeaders['Referer'] = targetURL.origin;
        fetchHeaders['Host'] = targetURL.host; 
        
        // A kérés törzsének (body) kezelése
        const fetchOptions = {
            method: req.method,
            headers: fetchHeaders,
            // Csak POST/PUT kérés esetén küldjük a body-t
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
        };
        
        const response = await fetch(targetURL.href, fetchOptions);

        // --- VÁLASZ ELŐKÉSZÍTÉSE ÉS Továbbítás ---

        const newRespHeaders = new Headers(response.headers);
        const contentType = newRespHeaders.get('content-type') || ''; 

        // KRITIKUS FEJLÉCEK TÖRLÉSE ÉS KÖTELEZŐ CORS BEÁLLÍTÁS MINDEN VÁLASZ ESETÉN!
        newRespHeaders.delete('content-encoding'); 
        newRespHeaders.delete('content-security-policy'); 
        newRespHeaders.delete('x-frame-options');
        newRespHeaders.delete('x-content-type-options'); 
        newRespHeaders.set('access-control-allow-origin', '*'); // Ezzel fixáljuk a CORS problémákat

        // Minden más fejléceket másolunk
        newRespHeaders.forEach((value, name) => {
            if (name.toLowerCase() !== 'content-length' && name.toLowerCase() !== 'content-encoding') { 
                res.setHeader(name, value);
            }
        });
        
        // A) HTML ESET: Átírás és küldés
        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
            console.log(`Handling HTML for: ${targetURL.href}`);
            const htmlText = await response.text();
            
            // Itt fut le a Roku document.domain eltávolítása is!
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
            if (targetURL.hostname.includes('tubitv.com')) {
                // Fontokat tartalmazó CDN-ek és API-k
                rewrittenContent = rewrittenContent.replaceAll('https://md0.tubitv.com', proxiedOriginPrefix + 'https://md0.tubitv.com');
                rewrittenContent = rewrittenContent.replaceAll('https://mcdn.tubitv.com', proxiedOriginPrefix + 'https://mcdn.tubitv.com');
                rewrittenContent = rewrittenContent.replaceAll('https://account.production-public.tubi.io', proxiedOriginPrefix + 'https://account.production-public.tubi.io');
                // ÚJ: Kiegészítés a hiányzó tensor-cdn domainnel
                rewrittenContent = rewrittenContent.replaceAll('https://tensor-cdn.production-public.tubi.io', proxiedOriginPrefix + 'https://tensor-cdn.production-public.tubi.io');
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
// 4. SZERVER INDÍTÁSA
// ===============================================

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
