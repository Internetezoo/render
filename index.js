// index.js

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================================
// 1. KONFIGURÁCIÓ (Beállítások)
// ===============================================

// A Render szolgáltatás domainje (pl. render-bj2x.onrender.com).
// KRITIKUS: Ezt be kell állítani a Render URL-jére!
const currentProxyDomain = process.env.PROXY_DOMAIN || 'localhost:3000';

// Minden kérést elfogadunk (POST, GET, stb.) és olvassuk a nyers kérés testet (body)
app.use(express.raw({ type: '*/*' }));

// ===============================================
// 2. FUNKCIÓK
// ===============================================

/**
 * Átírja a HTML tartalomban lévő URL-eket a proxy domainjére.
 */
function rewriteHtmlContent(html, targetURL, proxyDomain) {
    const $ = cheerio.load(html);

    // Csak a HTTP(S) linkeket, scripteket és képeket kell átírnunk.
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
                // Átalakítjuk abszolút URL-re, ha relatív
                const absoluteUrl = url.resolve(targetURL.href, originalUrl);
                
                // Csak HTTP(S) linkeket alakítunk át
                if (absoluteUrl.startsWith('http')) {
                    // Új URL formátum: /proxy?url=
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
                        // Ellenőrizzük, hogy a protokoll meg van-e adva
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

// Minden bejövő kérést ez a funkció dolgoz fel.
app.all('*', async (req, res) => {
    try {
        let targetURL;

        // A) Kezdőoldal: Ha a gyökérre érkezik kérés, de nincs 'url' paraméter
        if (req.path === '/' && !req.query.url) {
            return res.status(200).type('text/html').send(getHomePage(currentProxyDomain));
        }

        // B) A fő proxy logika: /proxy?url=...
        if (req.path === '/proxy' && req.query.url) {
            // URL objektum létrehozása a target URL-ből
            targetURL = new URL(req.query.url);
        } else {
            // Ha a kérés nem a gyökérre és nem a /proxy útvonalra érkezik
            if (!res.headersSent) {
                return res.status(404).send('Not Found or Invalid Proxy URL Format. Használja a /proxy?url=... formátumot.');
            }
            return;
        }

        console.log(`Proxying request for: ${targetURL.href}`);

        // -------------------------------------------------------------
        // A PROXY KÉRÉS ELKÜLDÉSE (fetch)
        // -------------------------------------------------------------
        
        const fetchOptions = {
            method: req.method,
            headers: {
                // Fejlécek felülírása/másolása
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
                'Referer': targetURL.origin,
                'Host': targetURL.host,
            },
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
        };
        
        // Elküldjük a kérést a céloldalnak
        const response = await fetch(targetURL.href, fetchOptions);

        // -------------------------------------------------------------
        // VÁLASZ ELŐKÉSZÍTÉSE ÉS Továbbítás
        // -------------------------------------------------------------

        // Fejlécek másolása a válaszból
        const newRespHeaders = new Headers(response.headers);
        const contentType = newRespHeaders.get('content-type') || ''; 

        // Biztonsági és CORS fejlécek Törlése/Felülírása (KRITIKUS)
        newRespHeaders.delete('content-security-policy'); 
        newRespHeaders.delete('x-frame-options');
        newRespHeaders.set('access-control-allow-origin', '*'); 

        // Minden más fejléceket másolunk az Express válaszba
        newRespHeaders.forEach((value, name) => {
            // Elkerüljük a Content-Length másolását a streameléskor
            if (name.toLowerCase() !== 'content-length') {
                res.setHeader(name, value);
            }
        });
        
        // A) HTML ESET: Átírás és szinkron küldés
        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
            console.log(`Handling HTML for: ${targetURL.href}`);
            const htmlText = await response.text();
            const rewrittenHtml = rewriteHtmlContent(htmlText, targetURL, currentProxyDomain);
            
            // Biztosítjuk a helyes Content-Type fejlécet
            res.setHeader('Content-Type', 'text/html; charset=utf-8'); 
            res.status(response.status).send(rewrittenHtml);
            
        } else {
            // B) MINDEN MÁS TARTALOM (JSON, CSS, JS, Képek)
            
            // Biztosítjuk, hogy a Content-Type fejléc be legyen állítva a másolt értékre
            res.setHeader('Content-Type', contentType); 

            console.log(`Streaming ${contentType} for: ${targetURL.href}`);
            res.status(response.status);
            
            // Továbbítjuk a nyers stream-et a kliensnek
            response.body.pipe(res);

            // Figyeljük a stream végét, hogy elkerüljük az akadozást/404-et
            response.body.on('error', (err) => {
                console.error('Stream error:', err);
                if (!res.headersSent) {
                    res.status(502).end();
                }
            });
        }

    } catch (error) {
        // Globális Hiba Kezelés (a try blokk bármilyen váratlan hibája)
        console.error(`PROXY CRITICAL ERROR for ${req.url}:`, error.message);
        
        // Ha még nem küldtünk el fejléceket, küldjünk 502-t!
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
