// Live feeds for the Dioma home page: tech/AI news, startup funding and top-company share prices.
// Fetched server-side (the Dioma page itself cannot reach other websites) and cached for 20 minutes.
const cache = new Map();
const TTL = 20 * 60 * 1000;

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}

const unescape = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/<[^>]+>/g, '').trim();

async function rss(url, limit = 12) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 DiomaBot/1.0' } });
  if (!res.ok) throw new Error(`Feed ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => unescape((m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1]);
    let title = get('title'); let source = get('source');
    if (!source && / - [^-]+$/.test(title)) source = title.split(' - ').pop();
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    items.push({ title, source, link: get('link'), published: get('pubDate') });
    if (items.length >= limit) break;
  }
  return items;
}

const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-AE&gl=AE&ceid=AE:en`;

const REGION = {
  uae: '(UAE OR Dubai OR "Abu Dhabi" OR Sharjah)',
  gcc: '(Saudi OR Riyadh OR Qatar OR Doha OR Kuwait OR Bahrain OR Oman OR GCC)',
  world: ''
};

export async function newsToday(region = 'world') {
  region = REGION[region] !== undefined ? region : 'world';
  const q = region === 'world'
    ? '(artificial intelligence OR AI OR OpenAI OR Anthropic OR Nvidia OR big tech OR startups) when:1d'
    : `(AI OR technology OR startup OR business OR logistics OR economy) ${REGION[region]} when:2d`;
  return cached('news:' + region, async () => {
    const items = await rss(gnews(q), 18);
    const seen = new Set();
    return items.filter((x) => x.title && !seen.has(x.title) && seen.add(x.title)).slice(0, 14);
  });
}

const STOCKS = {
  world: [['NVDA', 'Nvidia'], ['MSFT', 'Microsoft'], ['AAPL', 'Apple'], ['GOOGL', 'Alphabet'], ['AMZN', 'Amazon'], ['META', 'Meta'], ['AVGO', 'Broadcom'], ['TSLA', 'Tesla'], ['BRK-B', 'Berkshire Hathaway'], ['TSM', 'TSMC']],
  uae: [['EMIRATESNBD.AE', 'Emirates NBD'], ['EMAAR.AE', 'Emaar Properties'], ['DEWA.AE', 'DEWA'], ['DIB.AE', 'Dubai Islamic Bank'], ['EMAARDEV.AE', 'Emaar Development'], ['SALIK.AE', 'Salik'], ['DU.AE', 'du (EITC)'], ['AIRARABIA.AE', 'Air Arabia'], ['TALABAT.AE', 'talabat'], ['PARKIN.AE', 'Parkin']],
  gcc: [['2222.SR', 'Saudi Aramco'], ['1120.SR', 'Al Rajhi Bank'], ['1180.SR', 'Saudi National Bank'], ['QNBK.QA', 'QNB'], ['1211.SR', 'Ma\'aden'], ['7010.SR', 'stc'], ['2082.SR', 'ACWA Power'], ['2010.SR', 'SABIC'], ['KFH.KW', 'Kuwait Finance House'], ['EMIRATESNBD.AE', 'Emirates NBD (UAE)']]
};

async function quotes(region) {
  const list = STOCKS[region] || STOCKS.world;
  const one = async ([sym, name]) => {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) return null;
      const m = (((await res.json()).chart || {}).result || [])[0]?.meta || {};
      const price = m.regularMarketPrice, prev = m.chartPreviousClose ?? m.previousClose;
      if (price == null) return null;
      return { symbol: sym, name, price, currency: m.currency || 'USD', change_pct: prev ? Math.round(((price - prev) / prev) * 10000) / 100 : null, time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null };
    } catch { return null; }
  };
  return (await Promise.all(list.map(one))).filter(Boolean);
}

const FUND = {
  world: '(raises OR raised OR "funding round" OR "Series A" OR "Series B" OR "Series C" OR "seed round") startup when:2d',
  uae: `(raises OR raised OR funding OR "Series A" OR "Series B" OR seed OR investment) startup ${REGION.uae} when:14d`,
  gcc: `(raises OR raised OR funding OR "Series A" OR "Series B" OR seed OR investment) startup ${REGION.gcc} when:14d`
};

export async function moneyToday(region = 'world') {
  region = FUND[region] ? region : 'world';
  return cached('money:' + region, async () => {
    const [funding, stocks] = await Promise.all([
      rss(gnews(FUND[region]), 14).catch(() => []),
      quotes(region).catch(() => [])
    ]);
    return { region, funding, stocks, note: region === 'world' ? 'Delayed US prices; change vs previous close.' : 'Delayed local prices; change vs previous close.' };
  });
}

// What is trending in the UAE right now, from public sources (works without any login):
// Google Trends daily searches (AE) and X trending topics (trends24).
export async function trendsToday() {
  return cached('trends', async () => {
    // cache only a non-empty answer (see below)
    const out = { google: [], x: [] };
    try {
      const res = await fetch('https://trends.google.com/trending/rss?geo=AE', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const xml = await res.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const get = (tag) => unescape((m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1]);
        out.google.push({ title: get('title'), traffic: get('ht:approx_traffic'), news: get('ht:news_item_title'), link: get('ht:news_item_url') });
        if (out.google.length >= 20) break;
      }
    } catch { /* source down */ }
    try {
      const res = await fetch('https://trends24.in/united-arab-emirates/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await res.text();
      const first = (html.match(/<ol[^>]*trend-card__list[^>]*>([\s\S]*?)<\/ol>/) || [])[1] || html;
      const seen = new Set();
      for (const m of first.matchAll(/<a [^>]*href="([^"]*(?:x|twitter)\.com\/search[^"]*)"[^>]*>([^<]+)<\/a>/g)) { const t = unescape(m[2]); if (seen.has(t)) continue; seen.add(t); out.x.push({ title: t, link: m[1] }); if (out.x.length >= 20) break; }
    } catch { /* source down */ }
    return out;
  });
}

// Trending POSTS by region (UAE → GCC → World): news posts behind each Google trend + X trending tags.
const REGIONS = {
  uae: { tag: 'UAE', geos: ['AE'], t24: ['united-arab-emirates'] },
  gcc: { tag: 'GCC', geos: ['SA', 'KW', 'QA', 'BH', 'OM'], t24: ['saudi-arabia', 'kuwait', 'qatar', 'bahrain', 'oman'] },
  world: { tag: 'World', geos: ['US', 'GB', 'IN'], t24: [''] },
};
async function googleTrendPosts(geo) {
  const res = await fetch('https://trends.google.com/trending/rss?geo=' + geo, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const xml = await res.text(); const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1]; const get = (s, tag) => unescape((s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1]);
    const topic = get(it, 'title'), traffic = get(it, 'ht:approx_traffic');
    const news = [...it.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)].map((n) => ({ title: get(n[1], 'ht:news_item_title'), url: get(n[1], 'ht:news_item_url'), image: get(n[1], 'ht:news_item_picture'), source: get(n[1], 'ht:news_item_source') }));
    const n0 = news[0] || {};
    out.push({ topic, traffic, title: n0.title || topic, url: n0.url || 'https://www.google.com/search?q=' + encodeURIComponent(topic), image: n0.image || get(it, 'ht:picture'), source: n0.source || 'Google Trends', geo });
    if (out.length >= 10) break;
  }
  return out;
}
async function xTags(slug) {
  const res = await fetch('https://trends24.in/' + (slug ? slug + '/' : ''), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text(); const first = (html.match(/<ol[^>]*trend-card__list[^>]*>([\s\S]*?)<\/ol>/) || [])[1] || html; const out = []; const seen = new Set();
  for (const m of first.matchAll(/<a [^>]*href="([^"]*(?:x|twitter)\.com\/search[^"]*)"[^>]*>([^<]+)<\/a>/g)) { const t = unescape(m[2]); if (seen.has(t)) continue; seen.add(t); out.push({ tag: t, url: m[1] }); if (out.length >= 10) break; }
  return out;
}
// LinkedIn = business/professional news; Instagram = lifestyle/entertainment/viral; X & Facebook = Google Trends + X tags.
const NETQ = {
  linkedin: {
    uae: [gnews('(business OR startup OR logistics OR "supply chain" OR hiring OR "artificial intelligence" OR investment) UAE when:2d')],
    gcc: [gnews('(business OR startup OR logistics OR investment OR hiring OR "Vision 2030") (Saudi OR GCC OR Qatar OR Kuwait OR Oman OR Bahrain) when:2d')],
    world: ['https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en', 'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en'],
  },
  instagram: {
    uae: [gnews('Dubai OR "Abu Dhabi" (lifestyle OR food OR fashion OR travel OR event OR concert OR viral OR restaurant) when:2d')],
    gcc: [gnews('(Riyadh OR Jeddah OR Doha OR Kuwait OR Muscat) (event OR concert OR lifestyle OR viral OR festival OR food) when:2d')],
    world: ['https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=en-US&gl=US&ceid=US:en'],
  },
};
async function netTrend(net) {
  const Q = NETQ[net]; const out = { net, regions: [] };
  for (const [id, r] of Object.entries(REGIONS)) {
    const lists = await Promise.all(Q[id].map((u) => rss(u, 14).catch(() => [])));
    const posts = []; const seen = new Set();
    const junk = (it) => /stream|live free|watch live|free event|【|】|[\uFF01-\uFF5E]|\+\+/i.test(it.title) || /[\u3040-\u30FF\u4E00-\u9FFF]/.test(it.source || '') || it.title.trim() === String(it.source || '').trim() || it.title.split(/\s+/).length < 4;
    for (let i = 0; i < 14; i++) for (const l of lists) { const it = l[i]; if (!it || !it.title || junk(it)) continue; const k = it.title.toLowerCase().slice(0, 60); if (seen.has(k)) continue; seen.add(k); posts.push({ topic: it.title.split(/[:|–-]/)[0].trim().slice(0, 60), traffic: '', title: it.title, url: it.link, image: '', source: it.source || 'News', region: r.tag }); }
    out.regions.push({ id, tag: r.tag, posts: posts.slice(0, 12), xtags: [] });
  }
  if (!out.regions.some((x) => x.posts.length)) throw new Error('Trending sources did not answer, try again shortly');
  return out;
}
export async function trendPosts(net = '') {
  if (NETQ[net]) return cached('trendposts:' + net, () => netTrend(net));
  return cached('trendposts', async () => {
    const out = { regions: [] };
    for (const [id, r] of Object.entries(REGIONS)) {
      const posts = []; const seen = new Set();
      const lists = await Promise.all(r.geos.map((g) => googleTrendPosts(g).catch(() => [])));
      for (let i = 0; i < 10; i++) for (const l of lists) { const p = l[i]; if (p && !seen.has(p.topic.toLowerCase())) { seen.add(p.topic.toLowerCase()); posts.push({ ...p, region: r.tag }); } }
      const tl = await Promise.all(r.t24.map((s) => xTags(s).catch(() => [])));
      const tags = []; const ts = new Set(); for (let i = 0; i < 10; i++) for (const l of tl) { const t = l[i]; if (t && !ts.has(t.tag)) { ts.add(t.tag); tags.push(t); } }
      out.regions.push({ id, tag: r.tag, posts: posts.slice(0, 12), xtags: tags.slice(0, 12) });
    }
    if (!out.regions.some((x) => x.posts.length || x.xtags.length)) throw new Error('Trending sources did not answer, try again shortly');
    return out;
  });
}
