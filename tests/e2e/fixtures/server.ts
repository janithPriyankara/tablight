/**
 * Local test pages for the e2e suite: a tiny HTTP server on 127.0.0.1 (random port). Every page is
 * path-based (/p/<slug>) with a realistic <title> and no external resources, so the only network
 * traffic a test can see is to this server and to the extension itself.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestPage {
  slug: string;
  title: string;
}

/** 50 distinct pages across ~10 topics (titles in the style of the classifier fixture). */
export const PAGES: TestPage[] = [
  // AI
  { slug: 'ai-langgraph-agent-tutorial', title: 'Build an AI agent with LangGraph: step-by-step tutorial' },
  { slug: 'ai-openai-agents-sdk', title: 'Agents SDK quickstart: tool calling and multi-agent handoffs' },
  { slug: 'ai-transformers-attention', title: 'Attention Is All You Need explained: transformers and LLMs' },
  { slug: 'ai-rag-pipeline', title: 'Retrieval-augmented generation (RAG) with vector embeddings' },
  { slug: 'ai-fine-tune-llama', title: 'How to fine-tune Llama 3 with LoRA on a single GPU' },
  // Programming
  { slug: 'rust-async-tokio', title: 'Async Rust with Tokio: futures, tasks and channels' },
  { slug: 'python-asyncio-guide', title: 'Python asyncio guide: coroutines, event loops and await' },
  { slug: 'typescript-generics', title: 'TypeScript generics and conditional types handbook' },
  { slug: 'react-hooks-useeffect', title: 'React hooks: a complete guide to useEffect and useMemo' },
  { slug: 'git-rebase-interactive', title: 'Git rebase vs merge: rewriting commit history safely' },
  // Movies
  { slug: 'movie-oppenheimer-review', title: 'Oppenheimer (2023) movie review: Nolan’s biopic starring Cillian Murphy' },
  { slug: 'movie-dune-part-two', title: 'Dune: Part Two (2024) film: cast, trailer and showtimes' },
  { slug: 'movie-best-sci-fi-films', title: 'The 50 best sci-fi movies of all time, ranked' },
  { slug: 'movie-barbie-box-office', title: 'Barbie box office: Greta Gerwig film passes $1 billion' },
  { slug: 'movie-past-lives-trailer', title: 'Past Lives official trailer: A24 romantic drama film' },
  // Travel
  { slug: 'travel-kyoto-itinerary', title: 'Kyoto in 3 days: temples, food and travel itinerary' },
  { slug: 'travel-cheap-flights-lisbon', title: 'Cheap flights to Lisbon: compare airfares and airlines' },
  { slug: 'travel-iceland-ring-road', title: 'Iceland Ring Road trip: a 10-day self-drive itinerary' },
  { slug: 'travel-hotels-barcelona', title: 'Best hotels in Barcelona near Las Ramblas: book your stay' },
  { slug: 'travel-packing-list', title: 'Carry-on packing list for a two-week vacation abroad' },
  // Finance
  { slug: 'finance-index-funds', title: 'Index funds vs ETFs: how to start investing for retirement' },
  { slug: 'finance-mortgage-rates', title: 'Mortgage rates today: 30-year fixed refinance rates' },
  { slug: 'finance-roth-ira', title: 'Roth IRA contribution limits and tax rules for 2026' },
  { slug: 'finance-stock-market-today', title: 'Stock market today: S&P 500 and Nasdaq close higher on earnings' },
  { slug: 'finance-budget-spreadsheet', title: 'Personal budget spreadsheet: track spending and savings' },
  // Health
  { slug: 'health-strength-training', title: 'Beginner strength training workout plan: 3 days a week' },
  { slug: 'health-sleep-tips', title: 'How to sleep better: 12 science-backed tips for insomnia' },
  { slug: 'health-intermittent-fasting', title: 'Intermittent fasting: benefits, risks and a diet plan' },
  { slug: 'health-running-5k', title: 'Couch to 5K running plan for beginners' },
  { slug: 'health-blood-pressure', title: 'High blood pressure symptoms, causes and treatment' },
  // Music
  { slug: 'music-taylor-swift-album', title: 'Taylor Swift new album: tracklist, lyrics and release date' },
  { slug: 'music-learn-guitar-chords', title: 'Learn guitar chords: beginner lessons for acoustic guitar' },
  { slug: 'music-jazz-playlist', title: 'Late night jazz playlist: Miles Davis, Coltrane and Bill Evans' },
  { slug: 'music-concert-tickets', title: 'Coldplay world tour 2026: concert dates and tickets' },
  // Shopping
  { slug: 'shop-noise-cancelling-headphones', title: 'Sony WH-1000XM5 noise cancelling headphones: buy now, free shipping' },
  { slug: 'shop-running-shoes-sale', title: 'Running shoes sale: Nike and Adidas sneakers up to 40% off' },
  { slug: 'shop-laptop-deals', title: 'Best laptop deals this week: MacBook Air and Dell XPS discounts' },
  { slug: 'shop-standing-desk', title: 'Electric standing desk with memory presets: add to cart' },
  // News
  { slug: 'news-election-results', title: 'Election results live: latest updates from the polls' },
  { slug: 'news-climate-summit', title: 'World leaders agree on emissions targets at climate summit' },
  { slug: 'news-earthquake-report', title: 'Breaking news: magnitude 6.8 earthquake strikes off the coast' },
  // Games
  { slug: 'games-zelda-walkthrough', title: 'Zelda: Tears of the Kingdom walkthrough and shrine guide' },
  { slug: 'games-elden-ring-builds', title: 'Elden Ring best builds for beginners: weapons and stats' },
  { slug: 'games-steam-sale', title: 'Steam summer sale: best PC game deals' },
  // Cooking
  { slug: 'recipe-sourdough-bread', title: 'Easy sourdough bread recipe for beginners' },
  { slug: 'recipe-chicken-curry', title: 'Chicken tikka masala recipe: restaurant-style curry at home' },
  { slug: 'recipe-chocolate-chip-cookies', title: 'The best chocolate chip cookies recipe' },
  // Design
  { slug: 'design-figma-auto-layout', title: 'Figma auto layout tutorial: responsive UI design components' },
  { slug: 'design-color-palette', title: 'How to choose a color palette for your brand design' },
  { slug: 'design-typography-pairing', title: 'Typography pairing guide: fonts for web design' },
];

/**
 * Pages on a topic none of the starter groups covers (beekeeping): opened together they stay Unsorted and
 * become a suggested group (tests/e2e/ui-dashboard.spec.ts). Served under /p/<slug> like PAGES.
 */
export const TOPIC_PAGES: TestPage[] = [
  { slug: 'bees-first-hive', title: 'Beekeeping for beginners: setting up your first beehive' },
  { slug: 'bees-honey-harvest', title: 'How to harvest honey from a beehive without upsetting the bees' },
  { slug: 'bees-queen-bee', title: 'Beekeeping: how to spot the queen bee in a hive' },
  { slug: 'bees-swarm', title: 'Why honey bees swarm and how beekeepers catch a swarm' },
  { slug: 'bees-varroa', title: 'Varroa mites in beehives: beekeeping treatments that work' },
];
/** A second uncovered topic (knitting): its suggestion appearing proves a suggestion pass ran (ui-dashboard D-62). */
export const TOPIC_PAGES_2: TestPage[] = [
  { slug: 'knit-first-scarf', title: 'Knitting for beginners: how to knit your first scarf' },
  { slug: 'knit-cast-on', title: 'How to cast on stitches: a knitting tutorial with pictures' },
  { slug: 'knit-purl-stitch', title: 'Knit and purl stitches explained for new knitters' },
  { slug: 'knit-yarn-weights', title: 'Knitting yarn weights and needle sizes: a chart for knitters' },
  { slug: 'knit-sweater-pattern', title: 'Free knitting pattern: a cosy cable-knit sweater' },
];
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Titles of the Suspicious-tabs test pages (tests/e2e/suspicious.spec.ts). */
export const SUS_TITLES = {
  normal: 'Neighbourhood notice board',
  opener: 'Free movie streaming',
  popupOpener: 'Free game downloads',
  article: 'Gardening basics: growing tomatoes at home',
  recipe: "You won't believe this recipe",
  /** /click?key=1&visitor_id=2 */
  spam: 'Reveal your deposit bonus',
  /** /click?key=1&visitor_id=2&v=2 */
  spam2: 'Claim your prize: 50 free spins',
} as const;
const htmlPage = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  `<link rel="icon" href="data:,"></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
/**
 * The Suspicious-tabs pages. Targets come from repeated `to` query parameters (absolute URLs, so a page on
 * one host can open a page on another), rendered as attributes only.
 * - /normal: a normal page with a link (target=_blank) per target;
 * - /opener: a button per target that calls window.open(url);
 * - /popup-opener: a button per target that opens it in a pop-up window;
 * - /article, /recipe: plain pages; /click: the spam page (ad-click path and keys, scam-style title).
 */
function susPage(path: string, q: URLSearchParams): string | undefined {
  const to = q.getAll('to');
  const each = (fn: (u: string, n: number) => string) => to.map((u, n) => fn(escapeHtml(u), n)).join('');
  const script = (call: string) =>
    `<script>document.querySelectorAll('button[data-to]').forEach((b) => b.addEventListener('click', () => ${call}));</script>`;
  switch (path) {
    case '/normal':
      return htmlPage(SUS_TITLES.normal, each((u, n) => `<p><a id="link${n}" href="${u}" target="_blank">Link ${n}</a></p>`));
    case '/opener':
      return htmlPage(SUS_TITLES.opener, each((u, n) => `<p><button id="open${n}" data-to="${u}">Watch now ${n}</button></p>`) +
        script('window.open(b.dataset.to)'));
    case '/popup-opener':
      return htmlPage(SUS_TITLES.popupOpener, each((u, n) => `<p><button id="open${n}" data-to="${u}">Download ${n}</button></p>`) +
        script(`window.open(b.dataset.to, '_blank', 'popup,width=400,height=300')`));
    case '/article':
      return htmlPage(SUS_TITLES.article, '<p>Water them in the morning.</p>');
    case '/recipe':
      return htmlPage(SUS_TITLES.recipe, '<p>Just flour, water and salt.</p>');
    case '/click':
      return htmlPage(q.get('v') === '2' ? SUS_TITLES.spam2 : SUS_TITLES.spam, '<p>Spin to win!</p>');
    default:
      return undefined;
  }
}

export interface PageServer {
  /** http://127.0.0.1:<port> */
  origin: string;
  port: number;
  url: (slug: string, query?: string) => string;
  /** Date.now() when the last page (not favicon/404) was served; 0 before the first. */
  lastServedAt: () => number;
  close: () => Promise<void>;
}

/**
 * Starts the page server. /p/<slug> serves that page; the Suspicious-tabs pages are served by susPage;
 * /favicon.ico is an empty 204; the rest is 404.
 */
export async function startPageServer(): Promise<PageServer> {
  const bySlug = new Map([...PAGES, ...TOPIC_PAGES, ...TOPIC_PAGES_2].map((p) => [p.slug, p]));
  let lastServedAt = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const page = path.startsWith('/p/') ? bySlug.get(path.slice(3)) : undefined;
    if (path === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const sus = susPage(path, url.searchParams);
    if (sus !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(sus);
      return;
    }
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const title = escapeHtml(page.title);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    lastServedAt = Date.now();
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
      `<link rel="icon" href="data:,"></head><body><h1>${title}</h1><p>Local test page.</p></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    port,
    url: (slug, query) => `${origin}/p/${slug}${query ? `?${query}` : ''}`,
    lastServedAt: () => lastServedAt,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
