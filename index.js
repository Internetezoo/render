// index.js - Végleges, stabil Node.js/Express Proxy Service (Render.com)

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000; 

// ===============================================
// 1. KONFIGURÁCIÓ
// ===============================================

// A proxy domainje. Fontos, hogy be legyen állítva a Renderen a PROXY_DOMAIN.
const currentProxyDomain = process.env.PROXY_DOMAIN || 'localhost:3000';

// Minden kérést elfogadunk (POST, GET, stb.)
app.use(express.raw({ type: '*/*' }));

// ===============================================
// 2. FUNKCIÓK
// ===============================================

/**
 * Átírja a HTML tartalomban lévő URL-eket a proxy domainjére és injektálja a JS patch-et.
 */
function rewriteHtmlContent(html, targetURL, proxyDomain) {
    const $ = cheerio.load(html);
    
    // A proxizott URL-hez szükséges prefix
    const proxyPrefix = `https://${proxyDomain}/proxy?url=`;
    
    // Az eredeti céloldal gyökerét használjuk a JS kódhoz
    const originalTargetOrigin = targetURL.origin;

    // --- KRITIKUS JAVÍTÁS: Kliensoldali Hálózati Hívás Interceptor ---
    // Ez a script felülírja a böngésző fetch és XHR metódusait.
    const clientSidePatch = `
        <script>
            (function() {
                const proxyPrefix = '${proxyPrefix}';
                const currentProxyDomain = '${proxyDomain}';
                const originalTargetOrigin = '${originalTargetOrigin}';

                function resolveAndProxy(resource) {
                    // Ha a kérés abszolút, de nem proxizott (Tubi API hívás), proxyzzuk.
                    if (typeof resource === 'string' && resource.startsWith('http')) {
                        if (!resource.includes(currentProxyDomain)) {
                            // Hozzáadja a proxy?url= előtagot
                            return proxyPrefix + encodeURIComponent(resource);
                        }
                        return resource;
                    }
                    
                    // Ha a kérés relatív (pl. /s/1/7/... Roku asset), feloldjuk a céloldal gyökerére, majd proxyzzuk.
                    if (typeof resource === 'string' && resource.startsWith('/')) {
                        // Kézzel pótoljuk a hiányzó Roku címet
                        const absoluteUrl = originalTargetOrigin + resource;
                        // Hozzáadjuk a proxy?url= előtagot
                        return proxyPrefix + encodeURIComponent(absoluteUrl);
                    }

                    // Minden mást (pl. relatív könyvtár, vagy nem string) hagyunk.
                    return resource;
                }
                
                // 1. fetch() felülírása
                const originalFetch = window.fetch;
                window.fetch = function(resource, options) {
                    const proxiedResource = resolveAndProxy(resource);
                    return originalFetch(proxiedResource, options);
                };

                // 2. XMLHttpRequest.open() felülírása (XHR hívások elfogása)
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
                
                // Statikus gyökér-relatív linkek kezelése (/path/to/asset).
                if (originalUrl.startsWith('/') && !originalUrl.startsWith('//')) {
                    const absoluteUrl = targetURL.origin + originalUrl;
                    const proxiedUrl = `https://${proxyDomain}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                    $(element).attr(attribute, proxiedUrl);
                    return; 
                }

                // Minden más link
                const absoluteUrl = url.resolve(targetURL.href, originalUrl);
                
                if (absoluteUrl.startsWith('http')) {
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

        // B) A fő proxy logika: /proxy?url=...
        if (req.path === '/proxy' && req.query.url) {
            targetURL = new URL(req.query.url);
        } else {
            // A kérésnek szigorúan /proxy?url=... formátumúnak kell lennie, különben 404.
            if (!res.headersSent) {
                return res.status(404).send('Not Found or Invalid Proxy URL Format. Használja a /proxy?url=... formátumot.');
            }
            return;
        }

        console.log(`Proxying request for: ${targetURL.href}`);

        // --- PROXY KÉRÉS ELKÜLDÉSE (fetch) ---
        
        const fetchOptions = {
            method: req.method,
            headers: {
                // Fejlécek finomhangolása a 403-as hiba esélyének csökkentésére
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
                'Referer': targetURL.origin,
                'Host': targetURL.host,
                'Accept': req.headers['accept'] || '*/*',
                'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9,hu;q=0.8',
                'Content-Type': req.headers['content-type'] || undefined, 
            },
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
        };
        
        const response = await fetch(targetURL.href, fetchOptions);

        // --- VÁLASZ ELŐKÉSZÍTÉSE ÉS Továbbítás ---

        const newRespHeaders = new Headers(response.headers);
        const contentType = newRespHeaders.get('content-type') || ''; 

        // KRITIKUS FEJLÉCEK TÖRLÉSE MINDEN VÁLASZ ESETÉN!
        newRespHeaders.delete('content-encoding'); 
        newRespHeaders.delete('content-security-policy'); 
        newRespHeaders.delete('x-frame-options');
        newRespHeaders.delete('x-content-type-options'); 
        newRespHeaders.set('access-control-allow-origin', '*'); 

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
            const rewrittenHtml = rewriteHtmlContent(htmlText, targetURL, currentProxyDomain);
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8'); 
            res.status(response.status).send(rewrittenHtml);
            
        } else {
            // B) MINDEN MÁS TARTALOM (JS, JSON, CSS, Képek)
            
            res.setHeader('Content-Type', contentType); 

            console.log(`Streaming ${contentType} for: ${targetURL.href}`);
            res.status(response.status);
            
            // Továbbítjuk a nyers stream-et a kliensnek
            response.body.pipe(res);

            response.body.on('error', (err) => {
                console.error('Stream error:', err);
                if (!res.headersSent) {
                    res.status(502).end();
                }
            });
        }

    } catch (error) {
        // Globális Hiba Kezelés 
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
