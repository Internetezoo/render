// A Cloudflare specifikus globális objektumok (pl. HTMLRewriter) NEM érhetők el Node.js-ben.
// Használjon Node.js könyvtárakat, mint a 'cheerio' vagy 'jsdom' a HTML/CSS manipulációhoz.
const express = require('express');
const fetch = require('node-fetch'); // Modern Node.js verziókban már elérhető a globális fetch
const { URL } = require('url');
const app = express();
const PORT = process.env.PORT || 3000;

// Eredeti konfiguráció
const config = {
  // A proxyDomains már nem olyan releváns Node.js-ben, mint a Cloudflare Workers-ben.
  // Ide a Render.com-os domainjét írja be, ha több domain-t támogat.
  proxyDomains: ['localhost:3000', 'YOUR_RENDER_DOMAIN.render.com'], 
  separator: '------',
  homepage: true,
  allowedDomains: [],
  // ... a többi konfigurációs beállítás változatlan
  browserEmulation: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    acceptLanguage: 'en-US,en;q=0.9',
    acceptEncoding: 'gzip, deflate, br',
    connection: 'keep-alive',
    upgradeInsecureRequests: '1',
    secFetchDest: 'document',
    secFetchMode: 'navigate',
    secFetchSite: 'none',
    secFetchUser: '?1',
  },
  fallback: {
    enabled: true,
    autoReload: true,
  },
  specialSites: {
    wikipedia: {
      enabled: true,
      domains: ['wikipedia.org', 'wikimedia.org', 'mediawiki.org']
    }
  }
};

// --- Segítő függvények a URL átíráshoz ---
// Megtartva az eredeti logikát, de az HTMLRewriter kód helyébe Node.js API-k lépnek.

// ... (Az eredeti rewriteCSS és rewriteJavaScript függvények átmásolhatók ide) ...

// A HTMLRewriter osztályokat (LinkRewriter, SrcsetRewriter, stb.) 
// EGY Node.js-ben futó HTML manipulációs kódra kell cserélni.
// Például a `cheerio` library-vel:
function rewriteHtmlContent(html, targetURL, proxyDomain) {
    // Ezt a részt ki kell cserélni egy valódi HTML manipulációra Node.js-ben
    // A `cheerio` a leggyakoribb választás erre.
    // PÉLDA:
    // const $ = cheerio.load(html);
    // $('a[href]').each((i, el) => {
    //     const href = $(el).attr('href');
    //     const newHref = rewriteUrl(href, targetURL, proxyDomain);
    //     $(el).attr('href', newHref);
    // });
    // return $.html();

    console.warn("HTMLRewriter functions need to be replaced with a Node.js-compatible library like 'cheerio' or 'jsdom'.");
    return html; // Visszaadja a változatlan HTML-t, amíg nincs implementálva
}

// Új segéd: A teljes URL feloldását és proxy URL-re való átírását végzi
function rewriteUrl(attributeValue, baseURL, proxyDomain) {
    if (!attributeValue || attributeValue.startsWith('data:') || attributeValue.startsWith('javascript:')) return attributeValue;
    if (attributeValue.startsWith(`https://${proxyDomain}/`)) return attributeValue;
    
    try {
        let normalizedValue = attributeValue.trim();
        if (normalizedValue.startsWith('//')) {
          normalizedValue = baseURL.protocol + normalizedValue;
        }

        const absoluteURL = new URL(normalizedValue, baseURL);
        // A config.separator-t globálisan elérhetővé kell tenni, vagy átadni
        return `https://${proxyDomain}/${config.separator}${absoluteURL.href}`;
    } catch (e) {
        return attributeValue;
    }
}


// --- Fő Express Handler ---

app.use(express.raw({ type: '*/*' })); // Támogatja az összes content-type-ot bodyként

app.all('*', async (req, res) => {
  const url = new URL(req.originalUrl || req.url, `https://${req.headers.host}`);
  const request = req;

  // Az eredeti Cloudflare kód nagy része (targetURL meghatározás) átmásolható ide
  // ... (Az eredeti handleRequest logika ide kerül) ...
    
  // A Cloudflare Workers globális `URL` objektum használata helyett:
  // Az `url` változó már egy `URL` objektum, amely tartalmazza az összes szükséges információt.
    
  // Ellenőrizze, hogy az aktuális domain a proxy domainek egyike-e
  const isProxyHost = config.proxyDomains.includes(url.host);

  let targetURL;
  try {
    // 1. lépés: Cél URL meghatározása (az eredeti handleRequest funkció első felének átmásolása)
    if (isProxyHost) {
      if (url.pathname === '/') {
        // Kezdőoldal, keresés, referer alapú feloldás
        // ... (handleRequest belső logikája, ami a '/' útvonalat kezeli) ...
        if (config.homepage && !url.search) {
             // getHomePage() helyett küldjük el a HTML-t
             return res.status(200).type('text/html').send(getHomePage());
        }
        
        // Cél URL meghatározása a referer vagy query alapján, ha nem homepage a cél
        // Ez a rész bonyolult, és a teljes logikát át kell másolni a Cloudflare kódjából,
        // különös figyelemmel a hiba- és fallback-kezelésre.
        if (url.search) {
            const ref = request.headers.get('Referer') || '';
            // ... (Referer-es logika átmásolása) ...
        }
        
        // Ha nem találtunk érvényes target-et a '/' -en, akkor a targetURL-t meg kell határozni az alábbi útvonalak alapján
      }

      // /proxy?url=...
      if (url.pathname === '/proxy' && url.searchParams.has('url')) {
          targetURL = new URL(url.searchParams.get('url'));
      } 
      // /------https://example.com/
      else if (url.pathname.startsWith('/')) {
        const rawPath = url.pathname.substring(1);
        const sep = config.separator;
        let path = rawPath;
        if (rawPath.startsWith(sep)) {
          path = rawPath.substring(sep.length);
        }
        
        if (path.startsWith('http://') || path.startsWith('https://')) {
          targetURL = new URL(path);
        } else if (path) {
          // Relatív útvonalak és DuckDuckGo keresés (itt a legbonyolultabb a portolás)
          // ... (A Cloudflare kód megfelelő részének átmásolása) ...
          
          // Ezt a részt a Cloudflare kódjából kell átmásolni, de egyszerűsíthetjük a példa kedvéért:
          // Alapértelmezett viselkedés: ha van `path`, és nem URL, akkor DuckDuckGo-ra irányít
          if (!targetURL && !path.includes('.')) {
              targetURL = new URL('https://duckduckgo.com/?q=' + encodeURIComponent(path));
          } else if (!targetURL && path.includes('.')) {
              targetURL = new URL('https://' + path); // feltételezett domain
          }
          
          if (!targetURL) {
            return res.status(400).send('Invalid URL request');
          }
          
        } else {
            // Üres útvonal, de van query (pl. /?q=foo)
             if (url.searchParams.has('q')) {
                const ddgURL = new URL('https://duckduckgo.com/');
                url.searchParams.forEach((value, key) => ddgURL.searchParams.append(key, value));
                targetURL = ddgURL;
             } else {
                 return res.status(400).send('Invalid URL request');
             }
        }
      }
    } else {
      // Ha nem proxy hostként fut, használja a kérés URL-jét közvetlenül (ez a Render.com-on általában nem történik meg)
      targetURL = url;
    }

    // Domain Whitelist ellenőrzés
    if (config.allowedDomains.length > 0) {
      const isAllowed = config.allowedDomains.some(domain =>
        targetURL.hostname === domain || targetURL.hostname.endsWith(`.${domain}`)
      );
      if (!isAllowed) {
        return res.status(403).send('Domain not in whitelist');
      }
    }

  } catch (error) {
    return res.status(400).type('text/plain').send(`URL parsing error: ${error.message}`);
  }

  // --- Proxy kérés végrehajtása ---
  
  // Kérés fejlécek elkészítése (szinte változatlanul)
  let newHeaders = new fetch.Headers();
  
  // ... (Fejlécek másolása és browser emulation beállítása az eredeti kódból) ...
  const headersToKeep = [
    'cookie', 'range', 'if-none-match', 'if-modified-since', 'content-type', 'content-length'
  ];
  headersToKeep.forEach(header => {
    if (request.headers[header]) {
      newHeaders.set(header, request.headers[header]);
    }
  });

  // Add browser emulation headers
  Object.keys(config.browserEmulation).forEach(key => {
    newHeaders.set(key.replace(/([A-Z])/g, (g) => `-${g[0].toLowerCase()}`), config.browserEmulation[key]);
  });
  
  newHeaders.set('Host', targetURL.host);
  newHeaders.set('Origin', targetURL.origin);
  newHeaders.set('Referer', targetURL.href);
  
  const isXHR = request.headers['X-Requested-With'] === 'XMLHttpRequest' || request.headers['Accept']?.includes('application/json');
  if (isXHR) {
    newHeaders.set('X-Requested-With', 'XMLHttpRequest');
  }

  try {
    const fetchOptions = {
      method: req.method,
      headers: newHeaders,
      // Node.js Express-ben a req.body tartalmazza a nyers testet (a `express.raw` miatt)
      body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : null, 
      redirect: 'manual', 
      // További opciók, ha szükségesek, pl. timeout
    };
    
    // A fetch használata a `node-fetch`-el (vagy a natív fetch-el)
    let response = await fetch(targetURL.href, fetchOptions);

    // --- Válasz feldolgozása ---

    // Válasz fejlécek beállítása és manipulálása
    const newRespHeaders = response.headers; // A Headers objektum klónozása vagy újraépítése

    // Redirect-ek kezelése
    if (response.status >= 300 && response.status < 400 && response.headers.has('Location')) {
      const location = response.headers.get('Location');
      if (location) {
        try {
          const redirectURL = new URL(location, targetURL);
          const currentProxyDomain = url.host;
          // Új Location fejlécek beállítása a proxy URL-el
          const newLocation = `https://${currentProxyDomain}/${config.separator}${redirectURL.href}`;
          newRespHeaders.set('Location', newLocation);
        } catch (error) {
          console.error('Redirect URL processing error:', error);
        }
      }
    }

    // CORS fejlécek beállítása (a Cloudflare kódnak megfelelően)
    newRespHeaders.delete('Content-Security-Policy');
    newRespHeaders.delete('Content-Security-Policy-Report-Only');
    newRespHeaders.delete('X-Frame-Options');
    newRespHeaders.delete('X-Content-Type-Options');
    newRespHeaders.set('Access-Control-Allow-Origin', '*');
    newRespHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    newRespHeaders.set('Access-Control-Allow-Headers', '*');
    newRespHeaders.set('Access-Control-Allow-Credentials', 'true');

    // Fejlécek beállítása a Express válasz objektumon
    newRespHeaders.forEach((value, key) => {
        res.setHeader(key, value);
    });

    // Body tartalom manipulálása (az `HTMLRewriter` helyett)
    const contentType = newRespHeaders.get('Content-Type') || '';
    
    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
      const currentProxyDomain = url.host;
      const htmlText = await response.text();
      // EZT A RÉSZT KELL IMPLEMENTÁLNI NODE.JS-BEN (pl. cheerio-val)
      const rewrittenHtml = rewriteHtmlContent(htmlText, targetURL, currentProxyDomain);
      res.status(response.status).send(rewrittenHtml);
      return;
    } 
    else if (contentType.includes('text/css') || contentType.includes('application/x-stylesheet')) {
      const currentProxyDomain = url.host;
      const cssText = await response.text();
      const rewrittenCSS = rewriteCSS(cssText, targetURL, currentProxyDomain); // rewriteCSS függvényt át kell másolni
      res.status(response.status).send(rewrittenCSS);
      return;
    }
    else if (contentType.includes('application/javascript') || contentType.includes('text/javascript')) {
      const currentProxyDomain = url.host;
      const jsText = await response.text();
      const rewrittenJS = rewriteJavaScript(jsText, targetURL, currentProxyDomain); // rewriteJavaScript függvényt át kell másolni
      res.status(response.status).send(rewrittenJS);
      return;
    }
    
    // Minden más típusú tartalom továbbítása (stream-elés ajánlott, de egyszerűség kedvéért bufferelünk)
    response.body.pipe(res);
    res.status(response.status);

  } catch (error) {
    // Hiba oldal megjelenítése
    const errorPage = getErrorPage(error, targetURL);
    res.status(500).type('text/html').send(errorPage);
  }
});

// A homepage HTML kódja (változatlanul)
function getHomePage() {
  // ... (Az eredeti getHomePage() függvény tartalmát illessze be ide) ...
  return `<!DOCTYPE html>
  ... (eredeti HTML tartalom) ...
  `;
}

// Hiba oldal generálása (az eredeti HTML-ből)
function getErrorPage(error, targetURL) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Proxy Error</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
          }
          .error-container {
            background-color: #f8d7da;
            color: #721c24;
            padding: 15px;
            border-radius: 4px;
            margin-bottom: 20px;
          }
          .direct-access {
            background-color: #d4edda;
            color: #155724;
            padding: 15px;
            border-radius: 4px;
            margin-bottom: 20px;
          }
          h1 { color: #d63031; }
          a.direct-link {
            display: inline-block;
            margin-top: 10px;
            color: #fff;
            background-color: #17a2b8;
            padding: 8px 16px;
            text-decoration: none;
            border-radius: 4px;
          }
          a.direct-link:hover {
            background-color: #138496;
          }
          .details {
            background-color: #f8f9fa;
            padding: 15px;
            border-radius: 4px;
            margin-top: 20px;
            font-family: monospace;
            white-space: pre-wrap;
          }
        </style>
      </head>
      <body>
        <h1>Proxy Request Failed</h1>
        <div class="error-container">
          <strong>Error:</strong> ${error.message}
        </div>
        
        <div class="direct-access">
          <p>The proxy couldn't reach the requested resource. You can try to access it directly:</p>
          <a class="direct-link" href="${targetURL.href}" target="_blank">Open ${targetURL.href} directly</a>
        </div>
        
        <div class="details">
          Request URL: ${targetURL.href}
          Time: ${new Date().toISOString()}
        </div>
      </body>
      </html>
    `;
}

// --- Szerver Indítása ---

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
