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
