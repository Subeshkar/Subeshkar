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

export async function newsToday(topic = '') {
  const q = topic || '(artificial intelligence OR AI OR OpenAI OR Anthropic OR Nvidia OR big tech) when:1d';
  return cached('news:' + q, async () => {
    const [world, uae] = await Promise.all([
      rss(gnews(q), 12),
      rss(gnews('(AI OR technology OR startup OR logistics) (Dubai OR UAE) when:2d'), 6).catch(() => [])
    ]);
    const seen = new Set();
    return [...world, ...uae].filter((x) => x.title && !seen.has(x.title) && seen.add(x.title)).slice(0, 16);
  });
}

const TOP10 = [
  ['NVDA', 'Nvidia'], ['MSFT', 'Microsoft'], ['AAPL', 'Apple'], ['GOOGL', 'Alphabet'], ['AMZN', 'Amazon'],
  ['META', 'Meta'], ['AVGO', 'Broadcom'], ['TSLA', 'Tesla'], ['BRK-B', 'Berkshire Hathaway'], ['TSM', 'TSMC']
];

async function quotes() {
  // Stooq gives free delayed quotes as CSV, no key needed.
  const syms = TOP10.map(([s]) => s.toLowerCase().replace('-', '.') + '.us').join(',');
  const res = await fetch(`https://stooq.com/q/l/?s=${syms}&f=sd2t2ohlcv&h&e=csv`, { headers: { 'User-Agent': 'Mozilla/5.0 DiomaBot/1.0' } });
  if (!res.ok) throw new Error(`Quotes ${res.status}`);
  const lines = (await res.text()).trim().split('\n').slice(1);
  return lines.map((line) => {
    const [sym, date, time, open, high, low, close] = line.split(',');
    const t = TOP10.find(([s]) => s.toLowerCase().replace('-', '.') + '.us' === String(sym).toLowerCase());
    const c = Number(close), o = Number(open);
    return { symbol: t ? t[0] : sym, name: t ? t[1] : sym, price: isFinite(c) ? c : null, change_pct: isFinite(c) && isFinite(o) && o ? Math.round(((c - o) / o) * 10000) / 100 : null, date, time };
  }).filter((x) => x.price !== null);
}

export async function moneyToday() {
  return cached('money', async () => {
    const [funding, stocks] = await Promise.all([
      rss(gnews('(raises OR raised OR funding round OR Series A OR Series B OR Series C OR seed round) startup when:2d'), 14).catch(() => []),
      quotes().catch((e) => ({ error: e.message }))
    ]);
    return { funding, stocks: Array.isArray(stocks) ? stocks : [], stocks_error: Array.isArray(stocks) ? null : stocks.error, note: 'Share prices are delayed and change during market hours (US).' };
  });
}
