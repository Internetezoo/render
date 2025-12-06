const express = require('express');
const fetch = require('node-fetch'); 
const { URL } = require('url');
const cheerio = require('cheerio'); // HTML manipulációhoz
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware a nyers kérés testének kezelésére
app.use(express.raw({ type: '*/*' })); 

// --- Konfiguráció ---
const config = {
    // Ezt frissítse a Render.com-os domainjére!
    proxyDomain: 'YOUR_RENDER_DOMAIN.render.com', 
    separator: '------', 
    // ... a többi konfiguráció egyszerűsítve ...
};

// --- Segítő Függvények ---

/**
 * Átír egy URL-t abszolút URL-re, majd proxy URL-re.
 * @param {string} originalUrl - Az eredeti URL (lehet relatív is).
 * @param {URL} baseURL - A céloldal URL-je, amire a relatív URL-eket fel kell oldani.
 * @param {string} proxyDomain - A Render hostneve.
 * @returns {string} Az új proxizott URL.
 */
function rewriteUrl(originalUrl, baseURL, proxyDomain) {
    if (!originalUrl || originalUrl.startsWith('data:') || originalUrl.startsWith('javascript:')) {
        return originalUrl;
    }
    
    try {
        // 1. Relatív/protokoll-relatív URL-ek feloldása abszolút URL-re
        const absoluteURL = new URL(originalUrl, baseURL);
        
        // 2. Proxizott URL létrehozása
        // Példa: https://render.com/------https://example.com/path
        return `https://${proxyDomain}/${config.separator}${absoluteURL.href}`;
    } catch (e) {
        console.error(`URL rewrite error for ${originalUrl}:`, e.message);
        return originalUrl; // Hibás URL esetén hagyjuk érintetlenül
    }
}

/**
 * HTML tartalom átírása a Cheerio könyvtárral.
 * @param {string} htmlText - A nyers HTML.
 * @param {URL} targetURL - A cél URL.
 * @param {string} proxyDomain - A Render hostneve.
 * @returns {string} Az átírt HTML.
 */
function rewriteHtmlContent(htmlText, targetURL, proxyDomain) {
    const $ = cheerio.load(htmlText);

    // Kezelendő attribútumok és tag-ek
    const selectors = [
        'a[href]', 'link[href]', 'script[src]', 'img[src]', 'iframe[src]', 
        'source[src]', 'video[src]', 'audio[src]', 'embed[src]', 
        'form[action]', 'meta[content]' // Meta refresh és OG/Twitter képek
    ].join(',');

    $(selectors).each((i, el) => {
        const element = $(el);
        let attributeName = '';
        let originalValue = '';

        // Attribútum meghatározása a tag alapján
        if (element.is('a, link, meta')) {
            attributeName = element.is('meta') && element.attr('http-equiv') === 'refresh' ? 'content' : 'href';
        } else if (element.is('form')) {
            attributeName = 'action';
        } else if (element.is('script, img, iframe, source, video, audio, embed')) {
            attributeName = 'src';
        } else {
            return;
        }

        originalValue = element.attr(attributeName);

        if (originalValue) {
            let newUrl = originalValue;
            
            // Speciális eset: meta refresh URL kiolvasása
            if (element.is('meta') && element.attr('http-equiv')?.toLowerCase() === 'refresh') {
                const parts = originalValue.split(';url=');
                if (parts.length === 2) {
                    newUrl = parts[0] + ';url=' + rewriteUrl(parts[1], targetURL, proxyDomain);
                }
            } else {
                newUrl = rewriteUrl(originalValue, targetURL, proxyDomain);
            }
            
            element.attr(attributeName, newUrl);
        }
    });

    // TODO: Hasonló logika implementálása a CSS `url()`-re.
    // Ezt külön CSS-fájlokban a fő proxy handler kezeli.
    
    return $.html();
}

/**
 * CSS url() függvények átírása. (Átvéve az eredeti logikát)
 */
function rewriteCSS(css, baseURL, proxyDomain) {
    if (!css) return css;

    // Handle url() patterns
    return css.replace(/url\(\s*(['"]?)([^'")]+)(['"]?)\s*\)/g,
        function(match, quote1, url, quote2) {
            if (!url || url.startsWith('data:')) return match;
            try {
                const absoluteURL = new URL(url, baseURL);
                const newURL = `https://${proxyDomain}/${config.separator}${absoluteURL.href}`;
                return `url(${quote1}${newURL}${quote2})`;
            } catch (e) {
                return match;
            }
        }
    );
}


// --- Fő Express Route Handler ---

app.all('*', async (req, res) => {
    // 1. Állapotellenőrzés (Health Check)
    if (req.path === '/health') {
        return res.status(200).send('OK');
    }

    const currentProxyDomain = req.headers.host;
    let targetURL;

    try {
        // A) /proxy?url=https://example.com/ formatum kezelése (Kezdőoldali input)
        if (req.path === '/proxy' && req.query.url) {
            targetURL = new URL(req.query.url);
        } 
        // B) /------https://example.com/path formatum kezelése (Proxizott linkek kattintása)
        else if (req.path.startsWith(`/${config.separator}`)) {
            const pathAfterSeparator = req.path.substring(config.separator.length + 1);
            targetURL = new URL(pathAfterSeparator + req.url.substring(req.path.length));
        }
        // C) Kezdőoldal
        else if (req.path === '/' && !req.query.url) {
            return res.status(200).type('text/html').send(getHomePage(currentProxyDomain));
        } 
        else {
             // Ha nem felismerhető útvonal
            return res.status(404).send('Not Found or Invalid Proxy URL Format');
        }
    } catch (error) {
        return res.status(400).type('text/plain').send(`Invalid URL provided: ${error.message}`);
    }
    
    console.log(`Proxying request for: ${targetURL.href}`);

    // --- Kérés Előkészítése és Továbbítása ---

    const fetchHeaders = new fetch.Headers();
    
    // Alapvető fejlécek másolása a kényelmesebb proxyzáshoz
    const headersToKeep = ['cookie', 'range', 'content-type', 'content-length'];
    headersToKeep.forEach(header => {
        if (req.headers[header]) {
            fetchHeaders.set(header, req.headers[header]);
        }
    });

    // Browser emulation fejlécek
    fetchHeaders.set('User-Agent', 'Mozilla/5.0 (Node.js Proxy)');
    fetchHeaders.set('Host', targetURL.host);
    fetchHeaders.set('Origin', targetURL.origin);
    fetchHeaders.set('Referer', targetURL.href);

    try {
        const fetchOptions = {
            method: req.method,
            headers: fetchHeaders,
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : null,
            redirect: 'manual', 
        };
        
        let response = await fetch(targetURL.href, fetchOptions);

        // --- Válasz Feldolgozása ---
        
        const newRespHeaders = new fetch.Headers(response.headers);
        
        // Redirect-ek kezelése
        if (response.status >= 300 && response.status < 400 && newRespHeaders.has('Location')) {
            const location = newRespHeaders.get('Location');
            try {
                const redirectURL = new URL(location, targetURL);
                const newLocation = `https://${currentProxyDomain}/${config.separator}${redirectURL.href}`;
                newRespHeaders.set('Location', newLocation);
            } catch (error) {
                console.error('Redirect URL processing error:', error);
            }
        }
        
        // CORS és egyéb fejlécek törlése/felülírása
        newRespHeaders.delete('Content-Security-Policy');
        newRespHeaders.set('Access-Control-Allow-Origin', '*');
        
        // Fejlécek beállítása a Express válasz objektumon
        newRespHeaders.forEach((value, key) => {
            res.setHeader(key, value);
        });

        const contentType = newRespHeaders.get('Content-Type') || '';
        
        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
            const htmlText = await response.text();
            const rewrittenHtml = rewriteHtmlContent(htmlText, targetURL, currentProxyDomain);
            res.status(response.status).send(rewrittenHtml);
            return;
        } 
        else if (contentType.includes('text/css') || contentType.includes('application/x-stylesheet')) {
            const cssText = await response.text();
            const rewrittenCSS = rewriteCSS(cssText, targetURL, currentProxyDomain);
            res.status(response.status).send(rewrittenCSS);
            return;
        }
        
        // Minden más típusú tartalom továbbítása (képek, JSON stb.)
        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        // Hálózati hiba vagy a cél szerver elérhetetlen
        console.error(`Fetch error to ${targetURL.href}:`, error);
        res.status(502).type('text/html').send(getErrorPage(error, targetURL));
    }
});

// --- Segítő HTML Függvények ---

function getHomePage(host) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Render Simple Web Proxy</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; text-align: center; background-color: #f8f9fa; }
    .container { background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
    h1 { color: #3498db; }
    form { margin: 20px 0; }
    input[type="url"] { width: 80%; padding: 12px; font-size: 16px; border: 1px solid #ddd; border-radius: 4px 0 0 4px; box-sizing: border-box; }
    button { background: #3498db; color: white; border: none; padding: 12px 20px; font-size: 16px; border-radius: 0 4px 4px 0; cursor: pointer; }
    button:hover { background: #2980b9; }
    code { background: #eee; padding: 2px 4px; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Simple Render Proxy</h1>
    <p>Írja be az URL-t, amit a proxy segítségével szeretne megnyitni.</p>
    <form action="/proxy" method="GET">
      <input type="url" name="url" placeholder="Pl: https://example.com" required>
      <button type="submit">Proxy Go</button>
    </form>
    <p>A proxizott linkek ezután a következő formátumot fogják használni:</p>
    <code>https://${host}/${config.separator}https://targetsite.com/path</code>
  </div>
</body>
</html>`;
}

function getErrorPage(error, targetURL) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Proxy Error</title>
      <style>/* ... (Az eredeti hibajelző CSS-t illessze be ide) ... */</style>
    </head>
    <body>
      <h1>Proxy Request Failed</h1>
      <div class="error-container">
        <strong>Hiba:</strong> ${error.message}
      </div>
      <div class="direct-access">
        <p>A proxy nem érte el a céloldalt. Közvetlen elérés:</p>
        <a class="direct-link" href="${targetURL.href}" target="_blank">Open ${targetURL.href} directly</a>
      </div>
    </body>
    </html>
  `;
}

// --- Szerver Indítása ---

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
