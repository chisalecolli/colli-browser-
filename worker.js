export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");
    const screenWidth = parseInt(url.searchParams.get("w") || "240", 10);

    // Health check / instructions
    if (!targetUrl) {
      return new Response(JSON.stringify({
        status: "ok",
        message: "Opera Mini J2ME Transcoder Worker is running.",
        usage: "/?url=https://en.wikipedia.org&w=240"
      }), {
        headers: { "Content-Type": "application/json; charset=UTF-8" }
      });
    }

    try {
      // Normalize target URL
      let cleanTarget = targetUrl.trim();
      if (!cleanTarget.startsWith("http://") && !cleanTarget.startsWith("https://")) {
        cleanTarget = "https://" + cleanTarget;
      }

      // Fetch the page with mobile User-Agent
      const response = await fetch(cleanTarget, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        redirect: "follow"
      });

      const finalUrl = response.url || cleanTarget;
      const rawHtml = await response.text();

      // Transcode HTML into Opera Mini compact JSON
      const pageData = transcodeHtmlToJson(rawHtml, finalUrl, screenWidth);

      return new Response(JSON.stringify(pageData), {
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=120"
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({
        status: "error",
        title: "Connection Failed",
        url: targetUrl,
        elements: [
          { t: "h", lvl: 1, txt: "Network Error" },
          { t: "p", txt: "Could not fetch or transcode the requested page: " + (err.message || err.toString()) }
        ]
      }), {
        status: 200, // Return 200 so J2ME displays the error cleanly
        headers: { "Content-Type": "application/json; charset=UTF-8" }
      });
    }
  }
};

// ==================== TRANSCODER ENGINE ====================

function transcodeHtmlToJson(html, baseUrl, screenWidth) {
  // 1. Strip heavy blocks on the server
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  html = html.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
  html = html.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // 2. Extract Title
  let title = "Page";
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    title = decodeEntities(stripTags(titleMatch[1])).trim() || "Page";
  }

  // 3. Scan structural content
  const elements = [];
  const maxImgWidth = Math.min(200, screenWidth - 20);

  // Match tags of interest
  const tagRegex = /<(h[1-3]|p|a|img|blockquote|hr|input|button|textarea|select|li)\b([^>]*)>([\s\S]*?)<\/\1>|<(img|hr|input)\b([^>]*)\/?>/gi;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const tagName = (match[1] || match[4] || "").toLowerCase();
    const attrs = match[2] || match[5] || "";
    const innerContent = match[3] || "";

    if (tagName.startsWith("h")) {
      const lvl = parseInt(tagName.charAt(1), 10);
      const text = decodeEntities(stripTags(innerContent)).trim();
      if (text.length > 0) {
        elements.push({ t: "h", lvl, txt: text });
      }
    } else if (tagName === "p" || tagName === "li") {
      // Check if this paragraph contains links or plain text
      processParagraph(innerContent, baseUrl, elements);
    } else if (tagName === "a") {
      const href = resolveUrl(getAttr(attrs, "href"), baseUrl);
      const text = decodeEntities(stripTags(innerContent)).trim();
      if (text.length > 0 && href) {
        elements.push({ t: "a", txt: text, href });
      }
    } else if (tagName === "img") {
      const rawSrc = getAttr(attrs, "src") || getAttr(attrs, "data-src");
      const alt = decodeEntities(getAttr(attrs, "alt") || "Image").trim();
      if (rawSrc && !rawSrc.startsWith("data:") && isLegitImage(rawSrc)) {
        const absoluteSrc = resolveUrl(rawSrc, baseUrl);
        // Transcode WebP/SVG/AVIF into tiny J2ME JPEG via free image proxy
        const transcodedSrc = `https://wsrv.nl/?url=${encodeURIComponent(absoluteSrc)}&w=${maxImgWidth}&output=jpg&q=65`;
        elements.push({ t: "img", src: transcodedSrc, alt: alt.substring(0, 30) });
      }
    } else if (tagName === "blockquote") {
      const text = decodeEntities(stripTags(innerContent)).trim();
      if (text.length > 0) {
        elements.push({ t: "q", txt: text });
      }
    } else if (tagName === "hr") {
      elements.push({ t: "hr" });
    } else if (tagName === "input") {
      const type = (getAttr(attrs, "type") || "text").toLowerCase();
      const name = getAttr(attrs, "name");
      const val = getAttr(attrs, "value") || getAttr(attrs, "placeholder");
      if (type !== "hidden") {
        elements.push({ t: "in", itype: type, name, val });
      }
    }
  }

  // Fallback if the site had strange non-standard tags
  if (elements.length === 0) {
    const rawText = decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
    elements.push({ t: "p", txt: rawText.substring(0, 3000) });
  }

  return {
    status: "ok",
    title: title,
    url: baseUrl,
    count: elements.length,
    elements: elements
  };
}

// Extract mixed links and text inside <p> blocks
function processParagraph(content, baseUrl, elements) {
  const linkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let lastIndex = 0;
  let linkMatch;

  while ((linkMatch = linkRegex.exec(content)) !== null) {
    const beforeText = decodeEntities(stripTags(content.substring(lastIndex, linkMatch.index))).trim();
    if (beforeText.length > 0) {
      elements.push({ t: "p", txt: beforeText });
    }

    const href = resolveUrl(getAttr(linkMatch[1], "href"), baseUrl);
    const linkText = decodeEntities(stripTags(linkMatch[2])).trim();
    if (linkText.length > 0 && href) {
      elements.push({ t: "a", txt: linkText, href });
    }

    lastIndex = linkRegex.lastIndex;
  }

  const remainder = decodeEntities(stripTags(content.substring(lastIndex))).trim();
  if (remainder.length > 0) {
    elements.push({ t: "p", txt: remainder });
  }
}

// ==================== HELPERS ====================

function stripTags(str) {
  return (str || "").replace(/<[^>]*>/g, " ");
}

function decodeEntities(str) {
  return (str || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "...")
    .replace(/\s+/g, " ");
}

function getAttr(attrStr, attrName) {
  const match = new RegExp(attrName + `=["']([^"']*)["']`, "i").exec(attrStr);
  return match ? match[1] : "";
}

function resolveUrl(relative, base) {
  if (!relative) return "";
  try {
    return new URL(relative, base).href;
  } catch (e) {
    return relative;
  }
}

function isLegitImage(src) {
  const s = src.toLowerCase();
  if (s.includes("beacon") || s.includes("pixel") || s.includes("tracker") || s.includes("1x1")) {
    return false;
  }
  return true;
                          }
