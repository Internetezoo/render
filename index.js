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
 * Átírja a HTML tartalomban lévő URL-eket a proxy domainjére.
 */
function rewriteHtmlContent(html, targetURL, proxyDomain) {
    const $ = cheerio.load(html);
    
    // --- <base> tag eltávolítva. ---

    // Létrehozott/statikus linkek átírása
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
                
                // Gyökér-relatív linkek kezelése (/path/to/asset).
                if (originalUrl.startsWith('/') && !originalUrl.startsWith('//')) {
                    // Az abszolút URL: a céloldal gyökére + a relatív elérési út
                    const absoluteUrl = targetURL.origin + originalUrl;
                    
                    // A proxizott URL (https://proxy.com/proxy?url=https://target.com/path)
                    const proxiedUrl = `https://${proxyDomain}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                    $(element).attr(attribute, proxiedUrl);
                    return; 
                }

                // EREDETI LOGIKA: Minden más link (teljes URL-ek, relatív linkek)
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
 * Generálja az egyszerű kezdőoldalt. (Elhagyva az egyszerűség kedvéért a korábbi kód)
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
        
        // --- KRITIKUS JAVÍTÁS: Hibásan generált gyökér-relatív asset kérések elfogása ---
        // Ha a kérés nem tartalmaz /proxy?url=... paramétert, de egy assetre utal (pl. /s/...), 
        // megpróbáljuk a Referer fejléc alapján átirányítani a helyes proxy formátumra.
        if (req.path !== '/proxy' && req.headers['referer'] && (req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.includes('/s/'))) {
            
            const referrer = req.headers['referer'];
            let assumedTargetOrigin = ''; 

            try {
                const referrerUrl = new URL(referrer);
                // Ha a hivatkozó a mi proxy oldalunk
                if (referrerUrl.hostname === currentProxyDomain) {
                    const originalUrlParam = referrerUrl.searchParams.get('url');
                    if (originalUrlParam) {
                        // Kivonjuk belőle a céloldal gyökér URL-jét
                        const originalUrl = new URL(originalUrlParam);
                        assumedTargetOrigin = originalUrl.origin;
                    }
                }
            } catch(e) { /* Hiba esetén figyelmen kívül hagyjuk */ }
            
            if (assumedTargetOrigin) {
                const absoluteTargetUrl = assumedTargetOrigin + req.path;
                const correctProxyUrl = `/proxy?url=${encodeURIComponent(absoluteTargetUrl)}`;
                
                console.log(`REDIRECTING HIBÁS ASSET KÉRÉS: ${req.path} -> ${correctProxyUrl}`);
                return res.redirect(302, correctProxyUrl);
            }
        }
        // --- VÉGE: Hibásan generált asset kérések elfogása ---


        // B) A fő proxy logika: /proxy?url=...
        if (req.path === '/proxy' && req.query.url) {
            targetURL = new URL(req.query.url);
        } else {
            // Nem értelmezhető útvonal (404-et ad vissza)
            if (!res.headersSent) {
                return res.status(404).send('Not Found or Invalid Proxy URL Format. Használja a /proxy?url=... formátumot.');
            }
            return;
        }

        console.log(`Proxying request for: ${targetURL.href}`);

        // --- PROXY KÉRÉS ELKÜLDÉSE (fetch) ---
        
        // Kérés fejlécek beállítása a 403-as hiba esélyének csökkentésére
        const fetchOptions = {
            method: req.method,
            headers: {
                // Részletes User-Agent a blokkolás elkerülésére
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

        // KRITIKUS FEJLÉC TÖRLÉSEK: Ezeket MINDEN válasz esetén törölni kell!
        newRespHeaders.delete('content-encoding'); 
        newRespHeaders.delete('content-security-policy'); 
        newRespHeaders.delete('x-frame-options');
        newRespHeaders.delete('x-content-type-options'); 
        newRespHeaders.set('access-control-allow-origin', '*'); 

        // Minden más fejléceket másolunk
        newRespHeaders.forEach((value, name) => {
            // Elkerüljük a Content-Length és Content-Encoding másolását
            if (name.toLowerCase() !== 'content-length' && name.toLowerCase() !== 'content-encoding') { 
                res.setHeader(name, value);
            }
        });
        
        // A) HTML ESET: Átírás és küldés
        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
            console.log(`Handling HTML for: ${targetURL.href}`);
            const htmlText = await response.text();
            const rewrittenHtml = rewriteHtmlContent(htmlText, targetURL, currentProxyDomain);
            
            // Biztosítjuk a helyes Content-Type fejlécet
            res.setHeader('Content-Type', 'text/html; charset=utf-8'); 
            res.status(response.status).send(rewrittenHtml);
            
        } else {
            // B) MINDEN MÁS TARTALOM (JSON, CSS, JS, Képek)
            
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
        // Globális Hiba Kezelés (bármilyen váratlan hiba a try blokkban)
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
