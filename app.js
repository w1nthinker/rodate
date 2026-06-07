const DOCS_BASE_URL = "https://create.rotunnel.com/docs";
const FORUM_BASE_URL = "https://devforum.roblox.com";
const FORUM_CATEGORY_URL = `${FORUM_BASE_URL}/c/updates/release-notes/62.json`;
const EARLIEST_RELEASE = 308;
const MAX_FORUM_PAGES = 80;
const DETAIL_CONCURRENCY = 6;
const QUOTE_CONCURRENCY = 2;
const VIRTUAL_GAP = 18;
const FORUM_GRACE_MS = 3500;
const FETCH_TIMEOUT_MS = 20000;
const QUOTE_RETRY_DELAY_MS = 12000;
const CACHE_KEY = "rodate:release-cache:v3";
const THEME_KEY = "rodate:theme";
const SEARCH_KEY = "rodate:search";
const TIMEFRAME_KEY = "rodate:timeframe";
const CACHE_VERSION = 3;
const MAX_CACHED_DETAIL_RELEASES = 48;
const MAX_CACHED_QUOTE_RELEASES = 24;
const MAX_CACHED_ROW_TEXT = 220;
const CACHE_WRITE_DELAY_MS = 900;
const STATUS_NOTIFICATION_LIMIT = 4;
const NOTIFICATION_TTL_MS = 9000;
const TIMEFRAMES = [
  { id: "month", label: "This month" },
  { id: "year", label: "This year" },
  { id: "1m", label: "1 month" },
  { id: "3m", label: "3 months" },
  { id: "6m", label: "6 months" },
  { id: "1y", label: "1 year" },
  { id: "3y", label: "3 years" },
  { id: "5y", label: "5 years" },
  { id: "all", label: "All time" },
];
const READ_THROUGH_PROXIES = [
  {
    name: "Jina Reader",
    url: (url) => `https://r.jina.ai/http://${url}`,
  },
  {
    name: "AllOrigins",
    url: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
];
const CORS_LOCKED_HOSTS = new Set(["devforum.roblox.com"]);

const networkState = {
  proxyUsed: false,
  proxyName: "",
};

const COLORS = {
  ink: "#111111",
  muted: "#787774",
  line: "#EAEAEA",
  live: "#346538",
  liveSoft: "#EDF3EC",
  pending: "#956400",
  pendingSoft: "#FBF3DB",
  fixes: "#1F6C9F",
  fixesSoft: "#E1F3FE",
  improvements: "#9F2F2D",
  improvementsSoft: "#FDEBEC",
  unknown: "#C8C4BB",
};

const chartRegistry = new Map();

function rodateApp() {
  return {
    buildId: "",
    fatalError: "",
    warning: "",
    locale: navigator.language || "en-US",
    now: new Date(),
    activity: {
      stage: "Starting",
      detail: "waiting for network",
    },
    releasesByNumber: {},
    releaseOrder: [],
    creatorHubCurrentReleaseNumber: null,
    visibleReleases: [],
    detailQueue: [],
    detailQueued: {},
    detailWorkers: 0,
    activeDetailNumbers: {},
    quoteQueue: [],
    quoteQueued: {},
    quoteRetryAfter: {},
    quoteWorkers: 0,
    source: {
      forumPages: 0,
      forumTopics: 0,
      forumIndexComplete: false,
      forumIndexFailed: false,
      forumError: "",
      docsLoaded: 0,
      docsFailed: 0,
    },
    virtual: {
      scrollTop: 0,
      viewportHeight: 720,
      topPadding: 0,
      bottomPadding: 0,
      totalHeight: 0,
      heights: {},
      start: 0,
      end: 0,
      overscan: 520,
    },
    calendarOpen: false,
    calendarMonthKey: "",
    calendarMonthDraft: "",
    highlightRelease: null,
    expandedReleaseNumber: null,
    fallbackStarted: false,
    olderDiscoveryRunning: false,
    timeframeMode: "year",
    timeframeOpen: false,
    searchQuery: readStoredSearch(),
    releaseVersion: 0,
    orderedReleaseCache: {
      key: "",
      releases: [],
    },
    tableOpen: {},
    releaseFocusPressTimer: 0,
    releaseFocusHoldCompleted: false,
    themeMode: "system",
    resolvedTheme: "light",
    systemDeviceIcon: "ph-desktop",
    notifications: [],
    notificationSequence: 0,
    notifiedChanges: {},
    notifiedIssues: {},
    detailRun: {
      startedAt: 0,
      total: 0,
      completed: 0,
      label: "",
    },
    cacheWriteTimer: 0,
    cache: {
      restored: false,
      lastSavedAt: null,
      lastRestoredAt: null,
      loadedRows: 0,
    },
    cacheFlushHandler: null,
    renderFrame: 0,
    scrollFrame: 0,
    domFrame: 0,
    viewportResizeObserver: null,
    revealObserver: null,
    themeMediaQuery: null,

    init() {
      this.initTheme();
      this.initTimeframe();
      this.startDetailRun("Initial load");
      this.setupCacheFlushHandlers();
      this.setupRevealObserver();
      const restored = this.restoreCache();
      this.setActivity(
        restored ? "Refreshing" : "Reading build id",
        restored ? "cached data visible" : "current release",
      );
      this.$nextTick(() => {
        this.revealVisibleBlocks();
        this.mountVirtual();
        this.renderChartsSoon();
      });
      this.hydrate();
    },

    async hydrate() {
      let forumCount = 0;
      const forumPromise = this.loadForumIndex()
        .then((count) => {
          forumCount = count;
          return count;
        })
        .catch((error) => {
          this.markDevForumIndexFailed(error);
          this.notifyIssue(
            "DevForum dates unavailable",
            `Release changes will still load from Creator Hub. ${error.message}`,
            "devforum-index",
          );
          return 0;
        });

      try {
        const releaseIndex = await this.fetchCreatorHubReleaseIndex();
        this.buildId = releaseIndex.buildId;
        this.creatorHubCurrentReleaseNumber = releaseIndex.currentReleaseNumber;
        this.refreshNetworkWarning();
        this.setActivity(
          this.cache.restored ? "Refreshing changes" : "Build ID ready",
          this.cache.restored ? "background fetch" : this.compactBuildId(),
        );
        if (this.cache.restored) {
          this.enqueueMissingCreatorHubReleases();
          this.enqueueAllKnownReleaseDetails(false);
        }
        this.kickDetailWorkers();
      } catch (error) {
        this.fatalError = error.message;
        this.notifyIssue("Data could not be loaded", error.message, "build-id");
        this.setActivity("Stopped", "build id failed");
        return;
      }

      await Promise.race([forumPromise, wait(FORUM_GRACE_MS)]);

      if (forumCount === 0 && this.releaseOrder.length === 0) {
        await this.loadFallbackReleaseNumbers();
      }

      forumPromise.then((count) => {
        if (count === 0 && this.releaseOrder.length === 0) {
          this.loadFallbackReleaseNumbers();
        }
      });

      this.kickDetailWorkers();
    },

    async fetchCreatorHubReleaseIndex() {
      const html = await fetchText(`${DOCS_BASE_URL}/release-notes`);
      const match = html.match(
        /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
      );

      if (!match) {
        throw new Error(
          "Creator Hub did not expose __NEXT_DATA__ for release notes.",
        );
      }

      const nextData = JSON.parse(match[1]);
      if (!nextData.buildId) {
        throw new Error("Creator Hub __NEXT_DATA__ did not include a buildId.");
      }

      const currentReleaseNumber = parseCreatorHubCurrentReleaseNumber(nextData);
      if (!currentReleaseNumber) {
        throw new Error(
          "Creator Hub did not expose the current release number.",
        );
      }

      return {
        buildId: nextData.buildId,
        currentReleaseNumber,
      };
    },

    async loadForumIndex(options = {}) {
      let total = 0;
      let pagesWithoutTopics = 0;
      const stopWhenCaughtUp =
        options.stopWhenCaughtUp ?? this.cache.restored;
      this.source.forumIndexFailed = false;
      this.source.forumError = "";
      this.source.forumIndexComplete = false;

      for (let page = 0; page < MAX_FORUM_PAGES; page += 1) {
        const url =
          page === 0
            ? FORUM_CATEGORY_URL
            : `${FORUM_CATEGORY_URL}?page=${page}`;
        this.setActivity("Reading DevForum", `page ${page + 1}`);

        const json = await fetchJson(url);
        this.refreshNetworkWarning();
        const topics = json.topic_list?.topics || [];
        let pageTopics = 0;
        let pageChanged = false;

        for (const topic of topics) {
          const number = parseReleaseNumber(topic.title);
          if (!number) continue;

          const createdAt = topic.created_at || null;
          const existing = this.getRelease(number);
          const existingHasFullQuote = releaseHasFullQuote(existing);
          const excerptQuote = extractForumExcerpt(topic.excerpt, number);
          const forumPatch = {
            createdAt,
            lastReplyAt: topic.last_posted_at || null,
            topicId: topic.id || null,
            topicSlug: topic.slug || null,
            forumUrl: topic.id
              ? `${FORUM_BASE_URL}/t/${topic.slug || "release-notes"}/${
                  topic.id
                }`
              : "",
            quote: existingHasFullQuote
              ? existing.quote
              : excerptQuote || existing?.quote || "",
            quoteStatus:
              existingHasFullQuote
                ? "loaded"
                : excerptQuote
                  ? "excerpt"
                  : existing?.quoteStatus || "idle",
          };
          pageTopics += 1;
          pageChanged =
            pageChanged || forumPatchAddsMissingData(existing, forumPatch);
          total += this.upsertRelease(number, forumPatch) ? 1 : 0;

          if (this.releaseInTimeframe(this.getRelease(number))) {
            pageChanged = this.enqueueReleaseDetail(number) || pageChanged;
          }
        }

        this.source.forumPages = page + 1;
        this.source.forumTopics += pageTopics;
        this.setActivity(
          "Reading DevForum",
          `${this.source.forumTopics} releases`,
        );
        this.prefetchVisibleDevForumMessages();

        if (pageTopics === 0) {
          pagesWithoutTopics += 1;
        } else {
          pagesWithoutTopics = 0;
        }

        if (pagesWithoutTopics >= 2) {
          this.source.forumIndexComplete = true;
          break;
        }
        if (!json.topic_list?.more_topics_url && page > 0 && pageTopics === 0) {
          this.source.forumIndexComplete = true;
          break;
        }
        if (
          stopWhenCaughtUp &&
          pageTopics > 0 &&
          !pageChanged &&
          !this.needsMoreForumPagesForTimeframe()
        ) {
          break;
        }
        await wait(80);
      }

      this.source.forumIndexComplete = true;
      return total;
    },

    markDevForumIndexFailed(error) {
      this.source.forumIndexFailed = true;
      this.source.forumError = error?.message || "DevForum could not be read.";
      this.source.forumIndexComplete = false;
    },

    async loadFallbackReleaseNumbers() {
      if (this.fallbackStarted) return;
      this.fallbackStarted = true;
      this.setActivity("Discovering releases", "Creator Hub scan");
      const latest = this.creatorHubCurrentReleaseNumber;
      if (!latest) {
        throw new Error("Creator Hub current release number is unavailable.");
      }
      const floor = this.fallbackReleaseFloor(latest);
      const numbers = [];

      for (let n = latest; n >= floor; n -= 1) {
        numbers.push(n);
      }

      for (const n of numbers) {
        this.upsertRelease(n, {});
        this.enqueueReleaseDetail(n);
      }

      this.notifyIssue(
        "DevForum dates unavailable",
        "Release dates and quotes will appear when DevForum can be read.",
        "devforum-fallback",
      );
      this.setActivity("Queued Creator Hub", `${numbers.length} releases`);
    },

    async discoverOlderCreatorHubReleases() {
      if (this.olderDiscoveryRunning || !this.buildId) return;
      this.olderDiscoveryRunning = true;

      const knownNumbers = this.releaseOrder.filter(Number.isFinite);
      let n = knownNumbers.length
        ? Math.min(...knownNumbers) - 1
        : (this.creatorHubCurrentReleaseNumber || EARLIEST_RELEASE + 1) - 1;
      let misses = 0;

      this.startDetailRun("Backfilling all time");

      while (n > 0 && misses < 20 && this.timeframeMode === "all") {
        this.setActivity("Backfilling older notes", `release ${n}`);

        try {
          const rows = await this.fetchReleaseRows(n);
          this.upsertRelease(n, {});
          this.applyReleaseRows(n, rows, { fromNetwork: true });
          this.detailRun.total += 1;
          this.detailRun.completed += 1;
          misses = 0;
          this.renderChartsSoon();
          await wait(35);
        } catch (_error) {
          misses += 1;
        }

        n -= 1;
      }

      this.olderDiscoveryRunning = false;
      this.setActivity(
        "All-time backfill",
        misses >= 20 ? "stopped after missing run" : "complete",
      );
    },

    enqueueAllKnownReleaseDetails(force = false) {
      let queued = 0;
      for (const release of this.orderedReleases()) {
        if (this.enqueueReleaseDetail(release.number, { force })) {
          queued += 1;
        }
      }
      return queued;
    },

    enqueueMissingCreatorHubReleases() {
      const latest = this.creatorHubCurrentReleaseNumber;
      if (!latest) return 0;

      const knownNumbers = this.releaseOrder.filter(Number.isFinite);
      const newestKnown = knownNumbers.length ? Math.max(...knownNumbers) : 0;
      if (newestKnown >= latest) return 0;

      let queued = 0;
      for (let n = latest; n > newestKnown; n -= 1) {
        this.upsertRelease(n, {});
        if (this.releaseInTimeframe(this.getRelease(n))) {
          queued += this.enqueueReleaseDetail(n) ? 1 : 0;
        }
      }
      return queued;
    },

    enqueueReleaseDetail(number, options = {}) {
      const release = this.getRelease(number);
      const force = Boolean(options.force);
      if (!release || (release.detailStatus === "loaded" && !force)) {
        return false;
      }
      if (this.detailQueued[number]) return false;

      this.detailQueued[number] = true;
      this.detailQueue.push({ number, force });
      this.registerDetailWork(number);

      if (force && release.detailStatus === "loaded") {
        this.setRelease(number, { isRefreshing: true, refreshError: "" });
      } else {
        this.setRelease(number, {
          detailStatus:
            release.detailStatus === "idle" ? "queued" : release.detailStatus,
        });
      }

      if (this.buildId) {
        this.kickDetailWorkers();
      }

      return true;
    },

    kickDetailWorkers() {
      if (!this.buildId) return;

      while (
        this.detailWorkers < DETAIL_CONCURRENCY &&
        this.detailQueue.length > 0
      ) {
        this.detailWorkers += 1;
        this.detailWorker();
      }
    },

    async detailWorker() {
      while (this.detailQueue.length > 0) {
        const entry = this.detailQueue.shift();
        const number = typeof entry === "number" ? entry : entry.number;
        const force = typeof entry === "object" && Boolean(entry.force);
        delete this.detailQueued[number];

        const release = this.getRelease(number);
        if (!release || (release.detailStatus === "loaded" && !force)) continue;

        this.activeDetailNumbers[number] = true;
        if (force && release.detailStatus === "loaded") {
          this.setRelease(number, { isRefreshing: true, refreshError: "" });
        } else {
          this.setRelease(number, { detailStatus: "loading", error: "" });
        }
        this.setActivity("Scanning changes", `release ${number}`);

        try {
          const rows = await this.fetchReleaseRows(number);
          this.refreshNetworkWarning();
          this.applyReleaseRows(number, rows, {
            notify: this.cache.restored,
            fromNetwork: true,
          });
          this.source.docsLoaded += 1;
        } catch (error) {
          this.source.docsFailed += 1;
          if (force && release.detailStatus === "loaded") {
            this.setRelease(number, {
              isRefreshing: false,
              refreshError: error.message,
            });
          } else {
            this.setRelease(number, {
              detailStatus: "failed",
              error: error.message,
            });
          }
        }

        delete this.activeDetailNumbers[number];
        this.detailRun.completed = Math.min(
          this.detailRun.total,
          this.detailRun.completed + 1,
        );
        this.renderChartsSoon();
        await wait(35);
      }

      this.detailWorkers -= 1;
      if (this.detailQueue.length > 0) {
        this.kickDetailWorkers();
        return;
      }

      this.setActivity(
        this.detailWorkers === 0 ? "Scanned changes" : "Scanning changes",
        `${this.loadedReleaseCount()} of ${this.releaseOrder.length}`,
      );
      if (this.detailWorkers === 0 && this.detailQueue.length === 0) {
        this.flushCacheSave();
      }
    },

    async fetchReleaseRows(number) {
      const url =
        `${DOCS_BASE_URL}/_next/data/${this.buildId}/en-us/release-notes/release-notes-${number}.json` +
        `?slugs=en-us&slugs=release-notes&slugs=release-notes-${number}`;
      const json = await fetchJson(url);
      const rows = json.pageProps?.data?.releaseNoteContents?.content;

      if (!Array.isArray(rows)) {
        throw new Error(`Release ${number} did not include change entries.`);
      }

      return rows;
    },

    applyReleaseRows(number, rows, options = {}) {
      const previous = this.getRelease(number);
      const normalized = rows.map((row, index) =>
        normalizeRow(row, number, index),
      );
      const fixes = normalized.filter((row) => row.type === "Fixes");
      const improvements = normalized.filter(
        (row) => row.type === "Improvements",
      );
      const liveRows = normalized.filter((row) => isLive(row.status)).length;
      const pendingRows = normalized.filter((row) =>
        isPending(row.status),
      ).length;
      const statusChanges =
        options.notify && previous?.items?.length
          ? detectStatusChanges(previous.items, normalized)
          : [];

      if (statusChanges.length > 0) {
        this.queueStatusChangeNotification(number, statusChanges);
      }

      this.setRelease(number, {
        detailStatus: "loaded",
        isRefreshing: false,
        refreshError: "",
        items: normalized,
        fixes,
        improvements,
        totalRows: normalized.length,
        liveRows,
        pendingRows,
        unknownRows: normalized.length - liveRows - pendingRows,
        error: "",
      });
    },

    ensureQuote(release, options = {}) {
      if (!release?.topicId) return;
      if (releaseHasFullQuote(release) || release.quoteStatus === "loading") return;
      if (this.quoteQueued[release.number]) return;
      const retryAfter = this.quoteRetryAfter[release.number] || 0;
      if (retryAfter > Date.now() && !options.ignoreCooldown) return;
      if (
        (release.quoteStatus === "failed" || release.quoteStatus === "empty") &&
        !options.forceRetry
      ) {
        return;
      }

      this.quoteQueued[release.number] = true;
      if (options.priority) {
        this.quoteQueue.unshift(release.number);
      } else {
        this.quoteQueue.push(release.number);
      }
      this.kickQuoteWorkers();
    },

    prefetchVisibleDevForumMessages(options = {}) {
      for (const release of this.mountedReleases()) {
        this.ensureQuote(release, options);
      }
    },

    kickQuoteWorkers() {
      while (
        this.quoteWorkers < QUOTE_CONCURRENCY &&
        this.quoteQueue.length > 0
      ) {
        this.quoteWorkers += 1;
        this.quoteWorker();
      }
    },

    async quoteWorker() {
      while (this.quoteQueue.length > 0) {
        const number = this.quoteQueue.shift();
        delete this.quoteQueued[number];
        const release = this.getRelease(number);
        if (!release || !release.topicId) continue;

        this.setRelease(number, { quoteStatus: "loading" });

        try {
          const slug = release.topicSlug || "release-notes";
          const json = await fetchJson(
            `${FORUM_BASE_URL}/t/${slug}/${release.topicId}.json`,
          );
          this.refreshNetworkWarning();
          const firstPost =
            json.post_stream?.posts?.find((post) => post.post_number === 1) ||
            json.post_stream?.posts?.[0];
          const quote = firstPost?.cooked
            ? extractForumQuote(firstPost.cooked, release.number)
            : "";

          this.setRelease(number, {
            quote: quote || release.quote || "",
            quoteStatus: quote ? "loaded" : "empty",
          });
          if (quote) {
            delete this.quoteRetryAfter[number];
          } else {
            this.quoteRetryAfter[number] = Date.now() + QUOTE_RETRY_DELAY_MS;
            this.scheduleQuoteRetry(number);
          }
        } catch (_error) {
          this.setRelease(number, { quoteStatus: "failed" });
          this.quoteRetryAfter[number] = Date.now() + QUOTE_RETRY_DELAY_MS;
          this.scheduleQuoteRetry(number);
        }

        this.scheduleMessageLayoutRefresh(number);
        await wait(80);
      }

      this.quoteWorkers -= 1;
      if (this.quoteQueue.length > 0) {
        this.kickQuoteWorkers();
      }
    },

    upsertRelease(number, patch) {
      const existed = Boolean(this.releasesByNumber[number]);
      this.setRelease(number, patch);
      return !existed;
    },

    setRelease(number, patch) {
      const current = this.releasesByNumber[number] || emptyRelease(number);
      const next = {
        ...current,
        ...patch,
        number,
      };
      next.searchText = buildReleaseSearchText(next, this.locale);

      this.releasesByNumber = {
        ...this.releasesByNumber,
        [number]: next,
      };
      this.releaseVersion += 1;

      if (!this.releaseOrder.includes(number)) {
        this.releaseOrder = [...this.releaseOrder, number].sort(
          (a, b) => b - a,
        );
        this.virtual.heights[heightKey(number, false)] = estimateReleaseHeight(
          next,
          false,
        );
        this.virtual.heights[heightKey(number, true)] = estimateReleaseHeight(
          next,
          true,
        );
      }

      this.computeVirtualSoon();
      this.scheduleCacheSave();
    },

    getRelease(number) {
      return this.releasesByNumber[number] || null;
    },

    allReleases() {
      return this.releaseOrder
        .map((number) => this.releasesByNumber[number])
        .filter(Boolean);
    },

    orderedReleases() {
      const normalizedQuery = this.normalizedSearchQuery();
      const cacheKey = `${this.releaseVersion}:${this.timeframeMode}:${normalizedQuery}`;
      if (this.orderedReleaseCache.key === cacheKey) {
        return this.orderedReleaseCache.releases;
      }

      const terms = this.searchTerms(normalizedQuery);
      const releaseNumberQuery = this.searchReleaseNumberQuery(normalizedQuery);
      const releases = this.allReleases().filter((release) => {
        if (!this.releaseInTimeframe(release)) return false;
        return this.releaseMatchesSearch(release, terms, releaseNumberQuery);
      });

      this.orderedReleaseCache = {
        key: cacheKey,
        releases,
      };
      return releases;
    },

    normalizedSearchQuery() {
      return normalizeSearchText(this.searchQuery);
    },

    searchTerms(normalizedQuery = this.normalizedSearchQuery()) {
      return normalizedQuery.split(" ").filter(Boolean);
    },

    releaseMatchesSearch(
      release,
      terms = this.searchTerms(),
      releaseNumberQuery = this.searchReleaseNumberQuery(),
    ) {
      if (
        releaseNumberQuery &&
        !String(release.number).includes(releaseNumberQuery)
      ) {
        return false;
      }

      if (!terms.length) return true;
      const text = this.releaseSearchText(release);
      return terms.every((term) => text.includes(term));
    },

    searchReleaseNumberQuery(normalizedQuery = this.normalizedSearchQuery()) {
      const releaseMatch = normalizedQuery.match(/\brelease\s+(\d+)\b/);
      if (releaseMatch) return releaseMatch[1];
      if (/^\d+$/.test(normalizedQuery)) return normalizedQuery;
      return "";
    },

    releaseSearchText(release) {
      return release.searchText || buildReleaseSearchText(release, this.locale);
    },

    hasDevForumMessageSurface(release) {
      return Boolean(release);
    },

    hasFullDevForumMessage(release) {
      return releaseHasFullQuote(release);
    },

    hasDevForumPreview(release) {
      return Boolean(release?.quote && !releaseHasFullQuote(release));
    },

    devForumIndexIsLoading() {
      return (
        !this.source.forumIndexComplete && !this.source.forumIndexFailed
      );
    },

    devForumMessageIsLoading(release) {
      if (!release || releaseHasFullQuote(release)) return false;
      if (!release.topicId) return this.devForumIndexIsLoading();
      if (this.hasDevForumPreview(release)) {
        return (
          release.quoteStatus !== "failed" ||
          (this.quoteRetryAfter[release.number] || 0) > Date.now()
        );
      }
      return (
        ["idle", "queued", "loading"].includes(release.quoteStatus) ||
        (this.quoteRetryAfter[release.number] || 0) > Date.now()
      );
    },

    devForumMessageIsEmpty(release) {
      return (
        !this.hasFullDevForumMessage(release) &&
        !this.devForumMessageIsLoading(release)
      );
    },

    devForumMessageEmptyLabel(release) {
      if (!release?.topicId && this.source.forumIndexFailed) {
        return "DevForum is not responding through the browser network path.";
      }
      if (!release?.topicId) {
        return "DevForum post is still pending.";
      }
      if (release.quoteStatus === "empty") {
        return "DevForum message body was empty.";
      }
      return "DevForum message unavailable.";
    },

    onSearchChange() {
      writeStoredSearch(this.searchQuery);
      if (
        this.expandedReleaseNumber &&
        !this.orderedReleases().some(
          (release) => release.number === this.expandedReleaseNumber,
        )
      ) {
        this.expandedReleaseNumber = null;
      }
      this.computeVirtualSoon();
      this.renderChartsSoon();
      this.$nextTick(() => {
        if (this.$refs.historyViewport) {
          this.$refs.historyViewport.scrollTop = 0;
        }
      });
    },

    clearSearch() {
      if (!this.searchQuery) return;
      this.searchQuery = "";
      this.onSearchChange();
    },

    loadedReleases() {
      return this.orderedReleases().filter(
        (release) => release.detailStatus === "loaded",
      );
    },

    mountedReleases() {
      if (this.visibleReleases.length > 0) return this.visibleReleases;
      return this.orderedReleases().slice(0, 3);
    },

    mountedReleaseCount() {
      return this.mountedReleases().length;
    },

    currentReleaseCount() {
      return this.orderedReleases().length;
    },

    hasSearchQuery() {
      return this.searchTerms().length > 0;
    },

    historyShowsLoadingEmptyState() {
      return (
        this.currentReleaseCount() === 0 &&
        !this.fatalError &&
        !this.historyShowsSearchEmptyState()
      );
    },

    historyShowsSearchEmptyState() {
      return (
        this.currentReleaseCount() === 0 &&
        this.hasSearchQuery() &&
        this.discoveredReleaseCount() > 0
      );
    },

    discoveredReleaseCount() {
      return this.releaseOrder.length;
    },

    timeframeOptions() {
      return TIMEFRAMES;
    },

    initTimeframe() {
      const stored = readStoredTimeframe();
      this.timeframeMode = TIMEFRAMES.some((item) => item.id === stored)
        ? stored
        : "year";
    },

    setTimeframe(mode) {
      if (!TIMEFRAMES.some((item) => item.id === mode)) return;
      if (this.timeframeDisabled(mode)) return;
      this.timeframeMode = mode;
      writeStoredTimeframe(mode);
      this.timeframeOpen = false;
      if (
        this.expandedReleaseNumber &&
        !this.releaseInTimeframe(this.getRelease(this.expandedReleaseNumber))
      ) {
        this.expandedReleaseNumber = null;
      }
      this.startDetailRun(`Loading ${this.timeframeLabel().toLowerCase()}`);
      this.enqueueAllKnownReleaseDetails(false);
      this.computeVirtualSoon();
      this.renderChartsSoon();
      this.$nextTick(() => {
        if (this.$refs.historyViewport) {
          this.$refs.historyViewport.scrollTop = 0;
        }
      });
      if (mode === "all" || this.needsMoreForumPagesForTimeframe()) {
        this.loadForumIndex().catch((error) => {
          this.markDevForumIndexFailed(error);
          this.notifyIssue(
            "DevForum dates unavailable",
            `Release changes already cached will remain visible. ${error.message}`,
            `devforum-timeframe-${mode}`,
          );
        });
      }
      if (mode === "all" && this.buildId) {
        this.discoverOlderCreatorHubReleases();
      }
    },

    timeframeLabel() {
      return (
        TIMEFRAMES.find((item) => item.id === this.timeframeMode)?.label ||
        "This year"
      );
    },

    timeframeButtonClass(mode) {
      return {
        "is-active": this.timeframeMode === mode,
        "is-disabled": this.timeframeDisabled(mode),
      };
    },

    timeframeReleaseCount(mode) {
      return this.allReleases().filter((release) =>
        this.releaseInTimeframe(release, mode),
      ).length;
    },

    timeframeReleaseCountLabel(mode) {
      const count = this.timeframeReleaseCount(mode);
      return `${count}${this.timeframeCountIsPartial(mode) ? "+" : ""}`;
    },

    timeframeCountIsPartial(mode) {
      if (!TIMEFRAMES.some((item) => item.id === mode)) return false;
      if (this.source.forumIndexComplete) return false;
      if (mode === "all") return true;

      const coverageStart = this.timeframeCoverageStartDate();
      return !coverageStart || coverageStart > this.timeframeStartDate(mode);
    },

    timeframeCoverageStartDate() {
      let oldest = null;

      for (const release of this.allReleases()) {
        if (!release.createdAt) continue;
        const date = new Date(release.createdAt);
        if (Number.isNaN(date.getTime())) continue;
        if (!oldest || date < oldest) {
          oldest = date;
        }
      }

      return oldest;
    },

    timeframeDisabled(mode) {
      return !TIMEFRAMES.some((item) => item.id === mode);
    },

    timeframeStartDate(mode = this.timeframeMode) {
      const now = new Date();
      if (mode === "all") return new Date(0);
      if (mode === "month") {
        return new Date(now.getFullYear(), now.getMonth(), 1);
      }
      if (mode === "year") {
        return new Date(now.getFullYear(), 0, 1);
      }

      const monthMatch = mode.match(/^(\d+)m$/);
      if (monthMatch) {
        return new Date(
          now.getFullYear(),
          now.getMonth() - Number(monthMatch[1]),
          now.getDate(),
        );
      }

      const years = Number.parseInt(mode, 10);
      if (Number.isFinite(years)) {
        return new Date(now.getFullYear() - years, now.getMonth(), now.getDate());
      }

      return new Date(now.getFullYear(), 0, 1);
    },

    releaseInTimeframe(release, mode = this.timeframeMode) {
      if (!release) return false;
      if (mode === "all") return true;
      if (!release.createdAt) return !this.hasDatedReleases();
      return new Date(release.createdAt) >= this.timeframeStartDate(mode);
    },

    hasDatedReleases() {
      return this.releaseOrder.some(
        (number) => Boolean(this.releasesByNumber[number]?.createdAt),
      );
    },

    needsMoreForumPagesForTimeframe() {
      if (!this.releaseOrder.length) return true;
      if (this.timeframeMode === "all") return true;
      const oldestVisible = this.orderedReleases().at(-1);
      return !oldestVisible || new Date(oldestVisible.createdAt) > this.timeframeStartDate();
    },

    fallbackReleaseFloor(latest) {
      const spans = {
        month: 8,
        year: 70,
        "1m": 8,
        "3m": 24,
        "6m": 42,
        "1y": 70,
        "3y": 190,
        "5y": 320,
        all: latest - EARLIEST_RELEASE,
      };
      const span = spans[this.timeframeMode] ?? spans.year;
      return Math.max(EARLIEST_RELEASE, latest - span);
    },

    loadedReleaseCount() {
      return this.loadedReleases().length;
    },

    visibleReleaseScopeLabel() {
      return `${this.loadedReleaseCount()} indexed / ${this.currentReleaseCount()} available (${this.releaseScopeCopyLabel()})`;
    },

    releaseScopeCopyLabel() {
      if (this.searchTerms().length > 0) return "matching search";
      return this.timeframeCopyLabel();
    },

    timeframeCopyLabel() {
      const label = this.timeframeLabel().toLowerCase();
      if (label === "all time" || label.startsWith("this ")) return label;
      return `last ${label}`;
    },

    releaseRowLabel(release) {
      const count = release.totalRows || 0;
      return `${count} ${count === 1 ? "change" : "changes"}`;
    },

    pendingReleaseCount() {
      return this.loadedReleases().filter((release) => release.pendingRows > 0)
        .length;
    },

    totalRowCount() {
      return this.loadedReleases().reduce(
        (total, release) => total + release.totalRows,
        0,
      );
    },

    liveRowCount() {
      return this.loadedReleases().reduce(
        (total, release) => total + release.liveRows,
        0,
      );
    },

    pendingRowCount() {
      return this.loadedReleases().reduce(
        (total, release) => total + release.pendingRows,
        0,
      );
    },

    unknownRowCount() {
      return this.loadedReleases().reduce(
        (total, release) => total + release.unknownRows,
        0,
      );
    },

    progressPercent() {
      if (this.detailRun.total > 0) {
        return Math.max(
          2,
          Math.min(100, Math.round((this.detailRun.completed / this.detailRun.total) * 100)),
        );
      }
      const total = this.releaseOrder.length;
      if (!total) return this.buildId ? 8 : 3;
      const done =
        this.loadedReleaseCount() +
        this.orderedReleases().filter(
          (release) => release.detailStatus === "failed",
        ).length;
      return Math.max(3, Math.round((done / total) * 100));
    },

    progressVisible() {
      if (this.olderDiscoveryRunning) return true;
      if (this.detailWorkers > 0 || this.detailQueue.length > 0) return true;
      return this.detailRun.total > 0 && this.detailRun.completed < this.detailRun.total;
    },

    compactBuildId() {
      if (!this.buildId) return "reading";
      if (this.buildId.length <= 14) return this.buildId;
      return `${this.buildId.slice(0, 6)}...${this.buildId.slice(-6)}`;
    },

    setActivity(stage, detail) {
      this.activity = { stage, detail };
    },

    startDetailRun(label) {
      this.detailRun = {
        startedAt: Date.now(),
        total: 0,
        completed: 0,
        label,
      };
      this.activeDetailNumbers = {};
    },

    registerDetailWork(_number) {
      if (!this.detailRun.startedAt) {
        this.startDetailRun("Scanning changes");
      }
      this.detailRun.total += 1;
    },

    activeDetailCount() {
      return Object.keys(this.activeDetailNumbers).length;
    },

    queuedDetailCount() {
      return this.detailQueue.length;
    },

    progressLabel() {
      if (!this.detailRun.total) return "Idle";
      return `${this.detailRun.completed}/${this.detailRun.total}`;
    },

    progressEta() {
      if (!this.detailRun.startedAt || this.detailRun.completed <= 0) {
        return this.detailRun.total ? "calculating" : "ready";
      }

      const remaining = Math.max(0, this.detailRun.total - this.detailRun.completed);
      if (!remaining) return "done";

      const elapsed = Date.now() - this.detailRun.startedAt;
      const avg = elapsed / this.detailRun.completed;
      return formatDuration(avg * remaining);
    },

    refreshNetworkWarning() {
      return;
    },

    restoreCache() {
      let snapshot = null;

      try {
        snapshot = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      } catch (_error) {
        return false;
      }

      if (!snapshot || snapshot.version !== CACHE_VERSION) return false;
      if (!Array.isArray(snapshot.releases) || snapshot.releases.length === 0) {
        return false;
      }

      const restored = {};
      const heights = {};

      for (const cached of snapshot.releases) {
        const number = Number(cached.number);
        if (!number) continue;

        const items = hydrateCachedRows(cached.items, number);
        const fixes = items.filter((row) => row.type === "Fixes");
        const improvements = items.filter((row) => row.type === "Improvements");
        const liveRows = items.filter((row) => isLive(row.status)).length;
        const pendingRows = items.filter((row) => isPending(row.status)).length;
        const cachedQuote = restoreCachedQuote(cached);
        const release = {
          ...emptyRelease(number),
          ...cached,
          number,
          detailStatus: items.length
            ? "loaded"
            : cached.detailStatus === "loaded"
              ? "idle"
              : cached.detailStatus || "idle",
          quoteStatus: cachedQuote.status,
          isRefreshing: false,
          refreshError: "",
          quote: cachedQuote.quote,
          items,
          fixes,
          improvements,
          totalRows: items.length,
          liveRows,
          pendingRows,
          unknownRows: items.length - liveRows - pendingRows,
        };
        release.searchText = buildReleaseSearchText(release, this.locale);

        restored[number] = release;
        heights[heightKey(number, false)] = estimateReleaseHeight(
          release,
          false,
        );
        heights[heightKey(number, true)] = estimateReleaseHeight(
          release,
          true,
        );
      }

      const order = Array.isArray(snapshot.releaseOrder)
        ? snapshot.releaseOrder.map(Number).filter((number) => restored[number])
        : Object.keys(restored).map(Number);

      this.releasesByNumber = restored;
      this.releaseOrder = [...new Set(order)].sort((a, b) => b - a);
      this.releaseVersion += 1;
      this.orderedReleaseCache = { key: "", releases: [] };
      this.virtual.heights = { ...this.virtual.heights, ...heights };
      this.buildId = snapshot.buildId || this.buildId;
      this.source.docsLoaded = this.loadedReleaseCount();
      this.cache.restored = true;
      this.cache.lastSavedAt = snapshot.savedAt || null;
      this.cache.lastRestoredAt = Date.now();
      this.cache.loadedRows = this.totalRowCount();
      this.computeVirtualSoon();
      this.renderChartsSoon();

      return true;
    },

    scheduleCacheSave() {
      if (!this.releaseOrder.length) return;
      if (this.cacheWriteTimer) {
        window.clearTimeout(this.cacheWriteTimer);
      }

      this.cacheWriteTimer = window.setTimeout(() => {
        this.cacheWriteTimer = 0;
        this.saveCache();
      }, CACHE_WRITE_DELAY_MS);
    },

    setupCacheFlushHandlers() {
      if (this.cacheFlushHandler) return;
      this.cacheFlushHandler = () => this.flushCacheSave();
      window.addEventListener("pagehide", this.cacheFlushHandler);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.flushCacheSave();
        }
      });
    },

    flushCacheSave() {
      if (this.cacheWriteTimer) {
        window.clearTimeout(this.cacheWriteTimer);
        this.cacheWriteTimer = 0;
      }
      this.saveCache();
    },

    saveCache() {
      let cachedDetailReleases = 0;
      let cachedQuoteReleases = 0;
      const releases = this.allReleases()
        .filter(
          (release) =>
            release.detailStatus === "loaded" ||
            release.createdAt ||
            release.topicId,
        )
        .map((release) => {
          const shouldCacheDetails =
            release.detailStatus === "loaded" &&
            release.items?.length > 0 &&
            cachedDetailReleases < MAX_CACHED_DETAIL_RELEASES;
          if (shouldCacheDetails) {
            cachedDetailReleases += 1;
          }
          const cachedQuote = cacheableQuoteForRelease(
            release,
            cachedQuoteReleases < MAX_CACHED_QUOTE_RELEASES,
          );
          if (cachedQuote.status === "loaded") {
            cachedQuoteReleases += 1;
          }

          return {
            number: release.number,
            createdAt: release.createdAt,
            lastReplyAt: release.lastReplyAt,
            topicId: release.topicId,
            topicSlug: release.topicSlug,
            forumUrl: release.forumUrl,
            quote: cachedQuote.quote,
            quoteStatus: cachedQuote.status,
            detailStatus: shouldCacheDetails ? "loaded" : "idle",
            items: shouldCacheDetails ? release.items.map(compactCachedRow) : [],
          };
        });

      if (!releases.length) return;

      const snapshot = {
        version: CACHE_VERSION,
        savedAt: Date.now(),
        buildId: this.buildId,
        releaseOrder: this.releaseOrder,
        releases,
      };

      try {
        localStorage.removeItem(CACHE_KEY);
        localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
        this.cache.lastSavedAt = snapshot.savedAt;
        this.cache.loadedRows = this.totalRowCount();
      } catch (error) {
        const metadataOnly = {
          ...snapshot,
          releases: releases.map((release) => ({
            ...release,
            ...cacheableFallbackQuote(release),
            detailStatus: "idle",
            items: [],
          })),
        };

        try {
          localStorage.removeItem(CACHE_KEY);
          localStorage.setItem(CACHE_KEY, JSON.stringify(metadataOnly));
          this.cache.lastSavedAt = metadataOnly.savedAt;
          this.cache.loadedRows = 0;
        } catch (_fallbackError) {
          this.notifyIssue(
            "Browser cache is full",
            `Rodate will refresh from network on the next load. ${error.message}`,
            "cache-full",
          );
        }
      }
    },

    cacheLabel() {
      if (!this.cache.lastSavedAt) return "empty";
      const relative = new Intl.RelativeTimeFormat(this.locale, {
        numeric: "auto",
      }).format(
        Math.round((this.cache.lastSavedAt - Date.now()) / 60000),
        "minute",
      );
      return this.cache.restored ? `restored ${relative}` : `saved ${relative}`;
    },

    queueStatusChangeNotification(number, changes) {
      const unseen = changes.filter((change) => {
        const key = `${number}:${change.key}:${change.from}->${change.to}`;
        if (this.notifiedChanges[key]) return false;
        this.notifiedChanges[key] = true;
        return true;
      });

      if (!unseen.length) return;

      const title = `Release ${number} changed`;
      const body =
        unseen.length === 1
          ? `${unseen[0].from} to ${unseen[0].to}: ${truncateSentence(unseen[0].text, 96)}`
          : `${unseen.length} changes updated status.`;
      const notice = {
        id: ++this.notificationSequence,
        title,
        body,
        releaseNumber: number,
      };

      this.pushNotification(notice);
      this.sendBrowserNotification(title, body);

      this.scheduleNotificationDismiss(notice.id);
    },

    notifyIssue(title, body, key) {
      const issueKey = key || `${title}:${body}`;
      if (this.notifiedIssues[issueKey]) return;
      this.notifiedIssues[issueKey] = true;

      const notice = {
        id: ++this.notificationSequence,
        title,
        body,
        releaseNumber: null,
      };

      this.pushNotification(notice);
      this.sendBrowserNotification(title, body);
      this.scheduleNotificationDismiss(notice.id);
    },

    pushNotification(notice) {
      const nextNotice = {
        ...notice,
        visible: false,
      };

      this.notifications = [nextNotice, ...this.notifications]
        .slice(0, STATUS_NOTIFICATION_LIMIT)
        .map((item) =>
          item.id === nextNotice.id ? item : { ...item, visible: true },
        );

      window.setTimeout(() => {
        this.setNotificationVisible(nextNotice.id, true);
      }, 30);
    },

    setNotificationVisible(id, visible) {
      this.notifications = this.notifications.map((notice) =>
        notice.id === id ? { ...notice, visible } : notice,
      );
    },

    scheduleNotificationDismiss(id) {
      window.setTimeout(() => {
        this.dismissNotification(id);
      }, NOTIFICATION_TTL_MS);
    },

    dismissNotification(id) {
      this.setNotificationVisible(id, false);
      window.setTimeout(() => {
        this.notifications = this.notifications.filter(
          (notice) => notice.id !== id,
        );
      }, 380);
    },

    jumpToNotification(notice) {
      if (!notice?.releaseNumber) return;
      this.dismissNotification(notice.id);
      this.jumpToRelease(notice.releaseNumber, { expand: true });
    },

    sendBrowserNotification(title, body) {
      if (!("Notification" in window)) return;
      if (window.Notification.permission !== "granted") return;

      try {
        new window.Notification(title, {
          body,
          tag: `rodate-${title}`,
        });
      } catch (_error) {
        // In-app notices still cover browsers that block native notifications.
      }
    },

    initTheme() {
      this.themeMode = localStorage.getItem(THEME_KEY) || "system";
      this.themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      this.updateSystemDeviceIcon();
      this.applyTheme();

      this.themeMediaQuery.addEventListener?.("change", () => {
        if (this.themeMode === "system") {
          this.applyTheme();
        }
      });

      window.addEventListener("resize", () => this.updateSystemDeviceIcon(), {
        passive: true,
      });
    },

    setThemeMode(mode) {
      this.themeMode = mode;
      localStorage.setItem(THEME_KEY, mode);
      this.applyTheme();
    },

    applyTheme() {
      const systemDark = this.themeMediaQuery?.matches || false;
      const resolved =
        this.themeMode === "dark" ||
        (this.themeMode === "system" && systemDark)
          ? "dark"
          : "light";

      this.resolvedTheme = resolved;
      document.documentElement.dataset.rodateTheme = resolved;
      document.documentElement.dataset.rodateThemeMode = this.themeMode;
      document.documentElement.setAttribute("data-theme", resolved);
      this.renderChartsSoon();
    },

    updateSystemDeviceIcon() {
      this.systemDeviceIcon =
        window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 760
          ? "ph-device-mobile"
          : "ph-desktop";
    },

    themeButtonClass(mode) {
      return this.themeMode === mode ? "is-active" : "";
    },

    systemThemeIcon() {
      return this.systemDeviceIcon;
    },

    systemThemeLabel() {
      return `System theme, currently ${this.resolvedTheme}`;
    },

    mountVirtual() {
      const viewport = this.$refs.historyViewport;
      if (!viewport) return;

      this.virtual.viewportHeight = viewport.clientHeight || 720;
      this.virtual.scrollTop = viewport.scrollTop || 0;

      if (!this.viewportResizeObserver && "ResizeObserver" in window) {
        this.viewportResizeObserver = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (!entry) return;
          this.virtual.viewportHeight = entry.contentRect.height || 720;
          this.computeVirtualSoon();
          this.renderChartsSoon();
        });
        this.viewportResizeObserver.observe(viewport);
      }

      this.computeVirtual();
      this.scheduleDomWork();
    },

    onHistoryScroll(event) {
      const top = event.currentTarget.scrollTop;
      if (this.scrollFrame) {
        this.virtual.scrollTop = top;
        return;
      }

      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0;
        this.virtual.scrollTop = top;
        this.computeVirtual();
      });
    },

    computeVirtualSoon() {
      if (this.renderFrame) return;
      this.renderFrame = requestAnimationFrame(() => {
        this.renderFrame = 0;
        this.computeVirtual();
      });
    },

    computeVirtual() {
      const items = this.orderedReleases();
      const count = items.length;

      if (!count) {
        this.visibleReleases = [];
        this.virtual.topPadding = 0;
        this.virtual.bottomPadding = 0;
        this.virtual.totalHeight = 0;
        return;
      }

      const viewportHeight = this.virtual.viewportHeight || 720;
      const scrollTop = this.virtual.scrollTop || 0;
      if (this.collapseExpandedIfOutOfFocus(items, scrollTop, viewportHeight)) {
        this.computeVirtual();
        return;
      }
      const upperBound = Math.max(0, scrollTop - this.virtual.overscan);
      const lowerBound = scrollTop + viewportHeight + this.virtual.overscan;

      let topPadding = 0;
      let start = 0;
      while (start < count) {
        const height = this.heightFor(items[start]);
        if (topPadding + height >= upperBound) break;
        topPadding += height;
        start += 1;
      }

      let visibleHeight = 0;
      let end = start;
      while (end < count && topPadding + visibleHeight <= lowerBound) {
        visibleHeight += this.heightFor(items[end]);
        end += 1;
      }

      let totalHeight = topPadding + visibleHeight;
      for (let index = end; index < count; index += 1) {
        totalHeight += this.heightFor(items[index]);
      }

      this.visibleReleases = items.slice(start, end);
      this.virtual.start = start;
      this.virtual.end = end;
      this.virtual.topPadding = Math.max(0, topPadding);
      this.virtual.bottomPadding = Math.max(
        0,
        totalHeight - topPadding - visibleHeight,
      );
      this.virtual.totalHeight = totalHeight;

      this.scheduleDomWork();
    },

    heightFor(release) {
      const expanded = this.releaseIsExpanded(release.number);
      return (
        this.virtual.heights[heightKey(release.number, expanded)] ||
        estimateReleaseHeight(release, expanded)
      );
    },

    collapseExpandedIfOutOfFocus(items, scrollTop, viewportHeight) {
      if (!this.expandedReleaseNumber) return false;
      const index = items.findIndex(
        (release) => release.number === this.expandedReleaseNumber,
      );

      if (index < 0) {
        this.expandedReleaseNumber = null;
        return true;
      }

      let offset = 0;
      for (let i = 0; i < index; i += 1) {
        offset += this.heightFor(items[i]);
      }

      const height = this.heightFor(items[index]);
      const viewportStart = scrollTop - 24;
      const viewportEnd = scrollTop + viewportHeight + 24;
      const inFocus = offset + height > viewportStart && offset < viewportEnd;

      if (!inFocus) {
        this.expandedReleaseNumber = null;
        return true;
      }

      return false;
    },

    afterCardMounted(number) {
      const release = this.getRelease(number);
      if (release) this.ensureQuote(release, { priority: true });
      this.scheduleDomWork();
    },

    scheduleDomWork() {
      if (this.domFrame) return;
      this.domFrame = requestAnimationFrame(() => {
        this.domFrame = 0;
        this.$nextTick(() => {
          this.measureVisibleCards();
          this.revealVisibleBlocks();
          this.renderVisibleCharts();
          this.cleanupCharts();
        });
      });
    },

    scheduleMessageLayoutRefresh(number) {
      this.scheduleDomWork();
      window.setTimeout(() => {
        const release = this.getRelease(number);
        if (release && this.releaseIsExpanded(number)) {
          this.scheduleDomWork();
        }
      }, 260);
      window.setTimeout(() => {
        const release = this.getRelease(number);
        if (release && this.releaseIsExpanded(number)) {
          this.scheduleDomWork();
        }
      }, 520);
    },

    scheduleQuoteRetry(number) {
      window.setTimeout(() => {
        const release = this.getRelease(number);
        if (
          release &&
          this.releaseIsExpanded(number) &&
          this.tableIsOpen(number, "devforum")
        ) {
          this.ensureQuote(release, {
            forceRetry: true,
          });
          this.scheduleDomWork();
        }
      }, QUOTE_RETRY_DELAY_MS + 120);
    },

    measureVisibleCards() {
      let changed = false;

      for (const release of this.mountedReleases()) {
        const element = document.querySelector(
          `[data-release-number="${release.number}"]`,
        );
        if (!element) continue;

        const key = heightKey(
          release.number,
          this.releaseIsExpanded(release.number),
        );
        const measured = Math.ceil(element.offsetHeight + VIRTUAL_GAP);
        const current = this.virtual.heights[key] || 0;
        if (measured > 0 && Math.abs(measured - current) > 4) {
          this.virtual.heights[key] = measured;
          changed = true;
        }

        if (this.releaseIsExpanded(release.number)) {
          this.ensureQuote(release, {
            forceRetry: this.tableIsOpen(release.number, "devforum"),
            priority: true,
          });
        } else {
          this.ensureQuote(release);
        }
      }

      if (changed) {
        this.computeVirtualSoon();
      }
    },

    showStatusChart(release) {
      return release.detailStatus === "loaded" && release.pendingRows > 0;
    },

    releaseIsLoading(release) {
      return ["idle", "queued", "loading"].includes(release.detailStatus);
    },

    renderChartsSoon() {
      requestAnimationFrame(() => {
        this.$nextTick(() => {
          this.renderTopCharts();
          this.renderVisibleCharts();
          this.cleanupCharts();
        });
      });
    },

    renderTopCharts() {
      if (!window.echarts) return;

      const colors = themeColors();
      const foundReleases = this.currentReleaseCount();
      const loadedDetails = this.loadedReleaseCount();
      const pendingUpdates = this.pendingReleaseCount();
      const releaseDenominator = Math.max(foundReleases, 1);
      const releaseChart = getChart("release-overview-chart");
      if (releaseChart) {
        releaseChart.setOption({
          backgroundColor: "transparent",
          animationDuration: 600,
          animationDurationUpdate: 520,
          grid: {
            left: 136,
            right: 58,
            top: 4,
            bottom: 30,
          },
          tooltip: {
            trigger: "axis",
            axisPointer: { type: "shadow" },
            backgroundColor: colors.surface,
            borderColor: colors.line,
            textStyle: chartTextStyle(),
          },
          xAxis: {
            type: "value",
            max: Math.max(foundReleases, 1),
            minInterval: 1,
            splitLine: { lineStyle: { color: colors.line } },
            axisLabel: { color: colors.muted, fontFamily: "Geist Mono" },
          },
          yAxis: {
            type: "category",
            data: ["Pending Updates", "Loaded Details", "Found Releases"],
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: { color: colors.muted, fontFamily: "Geist Mono" },
          },
          series: [
            {
              type: "bar",
              barWidth: 22,
              data: [
                {
                  value: pendingUpdates,
                  percent: `${Math.round((pendingUpdates / releaseDenominator) * 100)}%`,
                  itemStyle: { color: colors.pending },
                },
                {
                  value: loadedDetails,
                  percent: `${Math.round((loadedDetails / releaseDenominator) * 100)}%`,
                  itemStyle: { color: colors.live },
                },
                {
                  value: foundReleases,
                  percent: "100%",
                  itemStyle: { color: colors.muted },
                },
              ],
              itemStyle: { borderRadius: [0, 5, 5, 0] },
              label: {
                show: true,
                position: "insideRight",
                distance: 10,
                formatter: (params) => params.data.percent,
                color: "#000000",
                opacity: 0.33,
                fontFamily: "Geist Mono",
                fontSize: 11,
                fontWeight: 700,
              },
            },
          ],
        });
      }

      const rowChart = getChart("row-status-chart");
      if (rowChart) {
        const data = [
          {
            name: "Live",
            value: this.liveRowCount(),
            itemStyle: { color: colors.live },
          },
          {
            name: "Pending",
            value: this.pendingRowCount(),
            itemStyle: { color: colors.pending },
          },
        ];

        if (this.unknownRowCount() > 0) {
          data.push({
            name: "Other",
            value: this.unknownRowCount(),
            itemStyle: { color: colors.unknown },
          });
        }

        rowChart.setOption(donutOption(data, "Changes"));
      }
    },

    renderVisibleCharts() {
      if (!window.echarts) return;

      const colors = themeColors();
      for (const release of this.mountedReleases()) {
        if (release.detailStatus !== "loaded") continue;
        if (!this.releaseIsExpanded(release.number)) continue;

        if (this.showStatusChart(release)) {
          const statusChart = getChart(
            `release-status-chart-${release.number}`,
          );
          if (statusChart) {
            statusChart.setOption(
              donutOption(
                [
                  {
                    name: "Live",
                    value: release.liveRows,
                    itemStyle: { color: colors.live },
                  },
                  {
                    name: "Pending",
                    value: release.pendingRows,
                    itemStyle: { color: colors.pending },
                  },
                ],
                "Status",
              ),
            );
          }
        }

        const typeChart = getChart(`release-type-chart-${release.number}`);
        if (typeChart) {
          typeChart.setOption(
            donutOption(
              [
                {
                  name: "Fixes",
                  value: release.fixes.length,
                  itemStyle: { color: colors.fixes },
                },
                {
                  name: "Improvements",
                  value: release.improvements.length,
                  itemStyle: { color: colors.improvements },
                },
              ],
              "Types",
            ),
          );
        }
      }
    },

    cleanupCharts() {
      for (const [id, chart] of chartRegistry.entries()) {
        if (!document.getElementById(id)) {
          chart.dispose();
          chartRegistry.delete(id);
        }
      }
    },

    setupRevealObserver() {
      if (!("IntersectionObserver" in window)) return;

      this.revealObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              this.revealObserver.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.08 },
      );
    },

    revealVisibleBlocks() {
      const blocks = document.querySelectorAll(".reveal:not(.is-visible)");
      for (const block of blocks) {
        if (this.revealObserver) {
          this.revealObserver.observe(block);
        } else {
          block.classList.add("is-visible");
        }
      }
    },

    openCalendar() {
      if (!this.calendarMonthKey) {
        this.calendarMonthKey = this.latestCalendarMonthKey();
      }
      this.calendarMonthDraft = this.calendarMonthKey;
      this.calendarOpen = true;
    },

    latestCalendarMonthKey() {
      const dated = this.orderedReleases().filter(
        (release) => release.createdAt,
      );
      if (!dated.length) return monthKey(new Date());

      const latest = dated.reduce((best, release) => {
        const date = new Date(release.createdAt);
        return date > best ? date : best;
      }, new Date(dated[0].createdAt));

      return monthKey(latest);
    },

    shiftCalendarMonth(delta) {
      const [year, month] = (this.calendarMonthKey || monthKey(new Date()))
        .split("-")
        .map(Number);
      const date = new Date(year, month - 1 + delta, 1);
      const nextKey = monthKey(date);
      this.calendarMonthKey = nextKey;
      this.calendarMonthDraft = nextKey;
    },

    handleCalendarMonthInput(value) {
      this.calendarMonthDraft = value;
      if (!/^\d{4}-\d{2}$/.test(String(value || ""))) return;

      const [year, month] = value.split("-").map(Number);
      if (month < 1 || month > 12) return;
      this.calendarMonthKey = value;
    },

    calendarOutOfRange() {
      const key = this.calendarMonthKey || this.latestCalendarMonthKey();
      return !this.calendarMonthAllowed(key);
    },

    calendarRangeMessage() {
      const bounds = this.calendarBounds();
      if ((this.calendarMonthKey || "") < bounds.min) {
        return `starts at ${bounds.min}`;
      }
      if ((this.calendarMonthKey || "") > bounds.max) {
        return `ends at ${bounds.max}`;
      }
      return "selected range has no releases in this month";
    },

    calendarMonthAllowed(key) {
      const bounds = this.calendarBounds();
      return key >= bounds.min && key <= bounds.max;
    },

    calendarBounds() {
      const releases = this.orderedReleases().filter(
        (release) => release.createdAt,
      );

      if (!releases.length) {
        const current = monthKey(new Date());
        return { min: current, max: current };
      }

      const releaseMonths = releases.map((release) =>
        monthKey(new Date(release.createdAt)),
      );
      const latest = releaseMonths.reduce((best, key) =>
        key > best ? key : best,
      );
      const earliestReleaseMonth = releaseMonths.reduce((best, key) =>
        key < best ? key : best,
      );
      const min =
        this.timeframeMode === "all"
          ? earliestReleaseMonth
          : monthKey(this.timeframeStartDate());

      return {
        min,
        max: latest,
      };
    },

    calendarTitle() {
      const [year, month] = (
        this.calendarMonthKey || this.latestCalendarMonthKey()
      )
        .split("-")
        .map(Number);
      return new Intl.DateTimeFormat(this.locale, {
        month: "long",
        year: "numeric",
      }).format(new Date(year, month - 1, 1));
    },

    calendarWeekdays() {
      const formatter = new Intl.DateTimeFormat(this.locale, {
        weekday: "short",
      });
      const start = this.weekStartsOn();
      return Array.from({ length: 7 }, (_item, index) => {
        const day = (start + index) % 7;
        return formatter.format(new Date(2024, 0, 7 + day));
      });
    },

    weekStartsOn() {
      try {
        const locale = new Intl.Locale(this.locale);
        if (locale.weekInfo?.firstDay) {
          return locale.weekInfo.firstDay % 7;
        }
      } catch (_error) {
        return 0;
      }
      return 0;
    },

    calendarDays() {
      const key = this.calendarMonthKey || this.latestCalendarMonthKey();
      const [year, month] = key.split("-").map(Number);
      const first = new Date(year, month - 1, 1);
      const daysInMonth = new Date(year, month, 0).getDate();
      const lead = (first.getDay() - this.weekStartsOn() + 7) % 7;
      const cells = 42;
      const groups = this.releasesByDate();

      return Array.from({ length: cells }, (_item, index) => {
        const date = new Date(year, month - 1, index - lead + 1);
        const dateKey = dayKey(date);
        const releases = groups[dateKey] || [];
        const pendingCount = releases.reduce(
          (total, release) => total + (release.pendingRows || 0),
          0,
        );

        return {
          key: dateKey,
          date,
          day: date.getDate(),
          inMonth: date.getMonth() === month - 1,
          releases,
          pendingCount,
        };
      });
    },

    releasesByDate() {
      return this.orderedReleases().reduce((groups, release) => {
        if (!release.createdAt) return groups;
        const key = dayKey(new Date(release.createdAt));
        if (!groups[key]) groups[key] = [];
        groups[key].push(release);
        groups[key].sort((a, b) => b.number - a.number);
        return groups;
      }, {});
    },

    calendarDotClass(release) {
      if (release.detailStatus !== "loaded") return "dot-pending";
      return release.pendingRows > 0 ? "dot-pending" : "dot-live";
    },

    calendarDayLabel(day) {
      const date = new Intl.DateTimeFormat(this.locale, {
        dateStyle: "medium",
      }).format(day.date);
      if (!day.releases.length) return date;
      const releases = day.releases.map((release) => release.number).join(", ");
      const pending =
        day.pendingCount > 0 ? `${day.pendingCount} pending changes` : "all live";
      return `${date}, releases ${releases}, ${pending}`;
    },

    resetChartHoverState(release) {
      const ids = [
        `release-status-chart-${release.number}`,
        `release-type-chart-${release.number}`,
      ];

      for (const id of ids) {
        const chart = chartRegistry.get(id);
        if (!chart) continue;
        chart.dispatchAction({ type: "downplay" });
        chart.dispatchAction({ type: "hideTip" });
        chart.setOption({
          series: [
            {
              label: { show: true },
              labelLine: { show: true },
            },
          ],
        });
      }
    },

    jumpToDate(day) {
      if (!day.releases.length) return;
      this.jumpToRelease(day.releases[0].number);
      this.calendarOpen = false;
    },

    jumpToRelease(number, options = {}) {
      const ordered = this.orderedReleases();
      const index = ordered.findIndex((release) => release.number === number);
      const viewport = this.$refs.historyViewport;
      if (index < 0) {
        if (this.getRelease(number) && this.timeframeMode !== "all") {
          this.timeframeMode = "all";
          writeStoredTimeframe("all");
          this.timeframeOpen = false;
          this.enqueueAllKnownReleaseDetails(false);
          this.computeVirtualSoon();
          this.renderChartsSoon();
          this.$nextTick(() => this.jumpToRelease(number, options));
        }
        return;
      }
      if (!viewport) return;

      if (options.expand !== false) {
        this.expandedReleaseNumber = number;
        this.enqueueReleaseDetail(number);
        this.ensureQuote(this.getRelease(number));
      }

      let offset = 0;
      for (let i = 0; i < index; i += 1) {
        offset += this.heightFor(ordered[i]);
      }

      const targetTop = Math.max(0, offset - 16);
      this.virtual.scrollTop = targetTop;
      viewport.scrollTo({ top: targetTop, behavior: "smooth" });
      this.highlightRelease = number;
      this.computeVirtualSoon();
      this.scheduleDomWork();
      window.setTimeout(() => {
        if (this.highlightRelease === number) {
          this.highlightRelease = null;
        }
      }, 2400);
    },

    scheduleReleaseFocus(number, delay = 0) {
      window.setTimeout(() => {
        this.$nextTick(() => {
          requestAnimationFrame(() => this.focusReleaseInView(number));
        });
      }, delay);
    },

    focusReleaseInView(number) {
      const viewport = this.$refs.historyViewport;
      const element = document.querySelector(
        `[data-release-number="${number}"]`,
      );
      if (!viewport || !element) return;

      const viewportRect = viewport.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const padding = 10;
      const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      let targetTop =
        viewport.scrollTop + elementRect.top - viewportRect.top - padding;

      if (elementRect.height <= viewport.clientHeight - padding * 2) {
        const bottomOverflow =
          elementRect.bottom - (viewportRect.bottom - padding);
        const topOverflow = elementRect.top - (viewportRect.top + padding);

        if (topOverflow >= 0 && bottomOverflow > 0) {
          targetTop = viewport.scrollTop + bottomOverflow;
        }
      }

      targetTop = Math.min(Math.max(0, targetTop), maxTop);
      this.virtual.scrollTop = targetTop;
      viewport.scrollTo({ top: targetTop, behavior: "smooth" });
      element.scrollTop = 0;
    },

    beginReleaseFocusHold(number) {
      this.cancelReleaseFocusHold();
      this.releaseFocusHoldCompleted = false;
      this.releaseFocusPressTimer = window.setTimeout(() => {
        this.releaseFocusPressTimer = 0;
        if (this.releaseIsExpanded(number)) {
          this.focusReleaseInView(number);
          this.releaseFocusHoldCompleted = true;
        }
      }, 520);
    },

    cancelReleaseFocusHold() {
      if (!this.releaseFocusPressTimer) return;
      window.clearTimeout(this.releaseFocusPressTimer);
      this.releaseFocusPressTimer = 0;
    },

    handleReleaseClick(number) {
      if (this.releaseFocusHoldCompleted) {
        this.releaseFocusHoldCompleted = false;
        return;
      }

      this.toggleRelease(number);
    },

    releaseIsExpanded(number) {
      return this.expandedReleaseNumber === number;
    },

    toggleRelease(number) {
      const expanded = this.releaseIsExpanded(number);
      this.expandedReleaseNumber = expanded ? null : number;
      const release = this.getRelease(number);

      if (!expanded && release) {
        this.enqueueReleaseDetail(number);
        this.ensureQuote(release);
        this.scheduleReleaseFocus(number, 80);
        this.scheduleReleaseFocus(number, 260);
      }

      this.computeVirtualSoon();
      this.scheduleDomWork();
    },

    docsUrl(number) {
      return `https://create.roblox.com/docs/release-notes/release-notes-${number}`;
    },

    openDocsRelease(number) {
      window.open(this.docsUrl(number), "_blank", "noopener");
    },

    openForumPost(release) {
      if (!release?.forumUrl) return;
      window.open(release.forumUrl, "_blank", "noopener");
    },

    async copyReleaseLink(number) {
      const url = this.docsUrl(number);
      try {
        await navigator.clipboard.writeText(url);
        this.notifyIssue(
          "Release link copied",
          `Release ${number} Creator Hub URL is in the clipboard.`,
          `copied-${number}-${Date.now()}`,
        );
      } catch (_error) {
        this.notifyIssue(
          "Clipboard unavailable",
          url,
          `clipboard-${number}`,
        );
      }
    },

    dateLine(release) {
      if (!release.createdAt) return "DevForum date pending";
      const timestamp = new Intl.DateTimeFormat(this.locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(release.createdAt));
      return `${timestamp} (${this.relativeDays(release.createdAt)})`;
    },

    relativeDays(value) {
      if (!value) return "Date unavailable";

      const start = startOfLocalDay(new Date(value));
      const today = startOfLocalDay(new Date());
      const diffDays = Math.round((start - today) / 86400000);

      return new Intl.RelativeTimeFormat(this.locale, {
        numeric: "auto",
      }).format(diffDays, "day");
    },

    releaseStatusLabel(release) {
      if (release.detailStatus === "failed") return "failed";
      if (release.detailStatus !== "loaded") return "loading";
      if (release.pendingRows > 0) return `${release.pendingRows} pending`;
      return "all live";
    },

    releaseStatusClass(release) {
      if (release.detailStatus === "failed") return "status-failed";
      if (release.detailStatus !== "loaded") return "status-loading";
      if (release.pendingRows > 0) return "status-pending";
      return "status-live";
    },

    statusClass(status) {
      if (isLive(status)) return "status-live";
      if (isPending(status)) return "status-pending";
      if (/fail/i.test(status)) return "status-failed";
      return "status-loading";
    },

    tableKey(number, type) {
      return `${number}:${type}`;
    },

    tableIsOpen(number, type) {
      const key = this.tableKey(number, type);
      return this.tableOpen[key] !== false;
    },

    toggleTable(number, type) {
      const key = this.tableKey(number, type);
      const willOpen = !this.tableIsOpen(number, type);
      this.tableOpen = {
        ...this.tableOpen,
        [key]: willOpen,
      };
      if (type === "devforum" && willOpen) {
        this.ensureQuote(this.getRelease(number), {
          forceRetry: true,
          priority: true,
        });
      }
      this.scheduleDomWork();
    },
  };
}

function emptyRelease(number) {
  return {
    number,
    createdAt: null,
    lastReplyAt: null,
    topicId: null,
    topicSlug: null,
    forumUrl: "",
    quote: "",
    quoteStatus: "idle",
    detailStatus: "idle",
    isRefreshing: false,
    error: "",
    refreshError: "",
    items: [],
    fixes: [],
    improvements: [],
    totalRows: 0,
    liveRows: 0,
    pendingRows: 0,
    unknownRows: 0,
    searchText: "",
  };
}

function normalizeRow(row, releaseNumber, index) {
  const type = row.ReleaseNotesType || row.Type || "Other";
  const status = row.Status || "Unknown";
  const text = row.ReleaseNotesText || row.Text || "";

  return {
    key: `${releaseNumber}-${index}`,
    signature: rowSignature(type, text),
    type,
    status,
    text: normalizeWhitespace(text),
  };
}

function compactCachedRow(row) {
  return {
    t: row.type,
    s: row.status,
    x: truncateCacheText(row.text),
  };
}

function hydrateCachedRows(rows, releaseNumber) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const type = row.t || row.type || "Other";
    const status = row.s || row.status || "Unknown";
    const text = normalizeWhitespace(row.x || row.text || "");

    return {
      key: `${releaseNumber}-${index}`,
      signature: row.signature || rowSignature(type, text),
      type,
      status,
      text,
    };
  });
}

function restoreCachedQuote(cached) {
  const quote = String(cached?.quote || "");
  if (!quote) return { quote: "", status: "idle" };
  if (releaseHasFullQuote(cached)) {
    return { quote, status: "loaded" };
  }
  return { quote, status: "excerpt" };
}

function cacheableQuoteForRelease(release, canCacheFullQuote) {
  const quote = String(release?.quote || "");
  if (!quote) return { quote: "", status: "idle" };

  if (looksLikeExcerpt(quote)) {
    return { quote, status: "excerpt" };
  }

  if (releaseHasFullQuote(release) && canCacheFullQuote) {
    return { quote, status: "loaded" };
  }

  return { quote: "", status: "idle" };
}

function cacheableFallbackQuote(release) {
  const quote = String(release?.quote || "");
  if (quote && looksLikeExcerpt(quote)) {
    return { quote, quoteStatus: "excerpt" };
  }
  return { quote: "", quoteStatus: "idle" };
}

function releaseHasFullQuote(release) {
  const quote = String(release?.quote || "");
  return Boolean(
    quote &&
      release?.quoteStatus === "loaded" &&
      !looksLikeExcerpt(quote),
  );
}

function forumPatchAddsMissingData(release, patch) {
  if (!release) return true;
  if (patch.createdAt && !release.createdAt) return true;
  if (patch.lastReplyAt && !release.lastReplyAt) return true;
  if (patch.topicId && !release.topicId) return true;
  if (patch.topicSlug && !release.topicSlug) return true;
  if (patch.forumUrl && !release.forumUrl) return true;
  if (patch.quote && !release.quote) return true;
  if (
    patch.quoteStatus &&
    patch.quoteStatus !== "idle" &&
    release.quoteStatus === "idle"
  ) {
    return true;
  }
  return false;
}

function truncateCacheText(value) {
  const text = normalizeWhitespace(value);
  if (text.length <= MAX_CACHED_ROW_TEXT) return text;
  return `${text.slice(0, MAX_CACHED_ROW_TEXT - 3).trim()}...`;
}

function parseReleaseNumber(title) {
  const match = String(title || "").match(/Release Notes for\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function parseCreatorHubCurrentReleaseNumber(nextData) {
  const navigationContent =
    nextData?.props?.pageProps?.navigation?.navigationContent;
  const stack = Array.isArray(navigationContent) ? [...navigationContent] : [];
  const releaseNumbers = [];

  while (stack.length > 0) {
    const item = stack.shift();
    if (!item || typeof item !== "object") continue;

    const pathMatch = String(item.path || "").match(
      /\/release-notes\/release-notes-(\d+)$/i,
    );
    if (pathMatch) {
      releaseNumbers.push(Number(pathMatch[1]));
    }

    const titleNumber = parseReleaseNumber(item.title);
    if (titleNumber) {
      releaseNumbers.push(titleNumber);
    }

    if (/^Current release$/i.test(String(item.title || ""))) {
      if (pathMatch) return Number(pathMatch[1]);
    }

    if (Array.isArray(item.navigation)) {
      stack.push(...item.navigation);
    }
    if (Array.isArray(item.section)) {
      stack.push(...item.section);
    }
  }

  return releaseNumbers.length ? Math.max(...releaseNumbers) : null;
}

async function fetchJson(url) {
  return fetchParsed(url, "application/json", (text) => {
    if (/not a robot|JavaScript is disabled/i.test(text)) {
      throw new Error("DevForum blocked the public JSON request.");
    }
    try {
      const parsed = JSON.parse(extractJsonPayload(text));
      if (typeof parsed?.data?.content === "string") {
        return JSON.parse(extractJsonPayload(parsed.data.content));
      }
      return parsed;
    } catch (_error) {
      throw new Error(`${new URL(url).hostname} did not return JSON`);
    }
  });
}

async function fetchText(url) {
  return fetchParsed(url, "text/html", (text) => text);
}

async function fetchParsed(url, accept, parse) {
  const sourceHost = new URL(url).hostname;
  const attempts = CORS_LOCKED_HOSTS.has(sourceHost)
    ? []
    : [{ url, proxy: false }];

  for (const proxy of READ_THROUGH_PROXIES) {
    attempts.push({ url: proxy.url(url), proxy: true, proxyName: proxy.name });
  }

  let lastError = null;

  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(attempt.url, {
        credentials: "omit",
        headers: { Accept: accept },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `${new URL(attempt.url).hostname} returned ${response.status}`,
        );
      }

      const text = await response.text();
      const parsed = parse(text);

      if (attempt.proxy) {
        networkState.proxyUsed = true;
        networkState.proxyName = attempt.proxyName || networkState.proxyName;
      }

      return parsed;
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError") {
        lastError = new Error(`${new URL(attempt.url).hostname} timed out`);
      }
    } finally {
      window.clearTimeout(timer);
    }
  }

  throw lastError || new Error(`${sourceHost} could not be read`);
}

function isLive(status) {
  return /^live$/i.test(String(status || "").trim());
}

function isPending(status) {
  return /^pending$/i.test(String(status || "").trim());
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function readStoredSearch() {
  try {
    return localStorage.getItem(SEARCH_KEY) || "";
  } catch (_error) {
    return "";
  }
}

function writeStoredSearch(value) {
  try {
    const query = String(value || "");
    if (query) {
      localStorage.setItem(SEARCH_KEY, query);
    } else {
      localStorage.removeItem(SEARCH_KEY);
    }
  } catch (_error) {
    // Search still works for the current session if storage is unavailable.
  }
}

function readStoredTimeframe() {
  try {
    return localStorage.getItem(TIMEFRAME_KEY) || "";
  } catch (_error) {
    return "";
  }
}

function writeStoredTimeframe(value) {
  try {
    localStorage.setItem(TIMEFRAME_KEY, String(value || "year"));
  } catch (_error) {
    // Timeframe selection still works for the current session if storage fails.
  }
}

function normalizeSearchText(value) {
  return normalizeWhitespace(
    normalizeWhitespace(value)
    .toLowerCase()
      .replace(/[_/.,:;()[\]{}'"`-]+/g, " "),
  );
}

function stripHtmlText(value) {
  const text = String(value || "");
  if (!text) return "";
  const doc = new DOMParser().parseFromString(text, "text/html");
  return normalizeWhitespace(doc.body?.textContent || text);
}

function releaseDateSearchParts(value, locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return [];

  const monthLong = new Intl.DateTimeFormat(locale, { month: "long" }).format(date);
  const monthShort = new Intl.DateTimeFormat(locale, { month: "short" }).format(date);
  const weekdayLong = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  const weekdayShort = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
  const start = startOfLocalDay(date);
  const today = startOfLocalDay(new Date());
  const diffDays = Math.round((start - today) / 86400000);
  const relative = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
  }).format(diffDays, "day");

  return [
    dateTime,
    relative,
    monthLong,
    monthShort,
    weekdayLong,
    weekdayShort,
    String(date.getFullYear()),
    String(date.getMonth() + 1),
    String(date.getDate()),
    monthKey(date),
    dayKey(date),
    `${date.getDate()} ${monthLong} ${date.getFullYear()}`,
    `${monthLong} ${date.getFullYear()}`,
    `${Math.abs(diffDays)} days ago`,
    diffDays === 0 ? "today" : "",
    diffDays === -1 ? "yesterday" : "",
  ];
}

function buildReleaseSearchText(release, locale) {
  const dateParts = release.createdAt
    ? releaseDateSearchParts(release.createdAt, locale)
    : ["date pending", "devforum date pending"];
  const rows = release.items || [];
  const rowText = rows
    .flatMap((row) => [row.type, row.status, row.text])
    .join(" ");
  const totalRows = release.totalRows || 0;
  const fixes = release.fixes?.length || 0;
  const improvements = release.improvements?.length || 0;
  const releaseStatus =
    release.detailStatus === "failed"
      ? "failed"
      : release.detailStatus !== "loaded"
        ? "loading"
        : release.pendingRows > 0
          ? `${release.pendingRows} pending`
          : "all live";

  return normalizeSearchText(
    [
      `release ${release.number}`,
      `release-notes-${release.number}`,
      `notes for release ${release.number}`,
      releaseStatus,
      `${totalRows} ${totalRows === 1 ? "change" : "changes"}`,
      `${totalRows} changes`,
      `${release.liveRows || 0} live`,
      `${release.pendingRows || 0} pending`,
      `${fixes} fixes`,
      `${improvements} improvements`,
      release.detailStatus,
      release.error,
      release.refreshError,
      release.topicSlug,
      release.forumUrl,
      stripHtmlText(release.quote),
      rowText,
      ...dateParts,
    ].join(" "),
  );
}

function rowSignature(type, text) {
  return `${normalizeWhitespace(type).toLowerCase()}::${normalizeWhitespace(text).toLowerCase()}`;
}

function detectStatusChanges(previousRows, nextRows) {
  const previousBySignature = new Map();

  for (const row of previousRows) {
    if (!row.text) continue;
    previousBySignature.set(
      row.signature || rowSignature(row.type, row.text),
      row,
    );
  }

  return nextRows
    .map((row) => {
      const previous = previousBySignature.get(
        row.signature || rowSignature(row.type, row.text),
      );
      if (!previous) return null;
      if (!isTrackableStatus(previous.status) || !isTrackableStatus(row.status)) {
        return null;
      }
      if (normalizeStatus(previous.status) === normalizeStatus(row.status)) {
        return null;
      }

      return {
        key: row.signature || row.key,
        type: row.type,
        text: row.text,
        from: normalizeStatus(previous.status),
        to: normalizeStatus(row.status),
      };
    })
    .filter(Boolean);
}

function isTrackableStatus(status) {
  return isLive(status) || isPending(status);
}

function normalizeStatus(status) {
  if (isLive(status)) return "Live";
  if (isPending(status)) return "Pending";
  return normalizeWhitespace(status) || "Unknown";
}

function extractForumExcerpt(html, releaseNumber) {
  if (!html) return "";
  return String(html).trim();
}

function looksLikeExcerpt(value) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(value || ""), "text/html");
  const text = normalizeWhitespace(doc.body?.textContent || value);
  return /(\.\.\.|…)$/.test(text) || /r\.\.\.$/.test(text);
}

function extractJsonPayload(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  const marker = "Markdown Content:";
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex < 0) return trimmed;

  const markdown = trimmed.slice(markerIndex + marker.length).trim();
  const objectStart = markdown.search(/[{[]/);
  if (objectStart < 0) return markdown;

  return markdown.slice(objectStart).trim();
}

function extractForumQuote(html, releaseNumber) {
  return String(html || "").trim();
}

function truncateSentence(value, limit) {
  const text = normalizeWhitespace(value);
  if (text.length <= limit) return text;

  const clipped = text.slice(0, limit);
  const sentenceEnd = Math.max(
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("?"),
    clipped.lastIndexOf("!"),
  );

  if (sentenceEnd > limit * 0.55) {
    return clipped.slice(0, sentenceEnd + 1);
  }

  const wordEnd = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, wordEnd > 0 ? wordEnd : limit)}...`;
}

function heightKey(number, expanded) {
  return `${number}:${expanded ? "open" : "closed"}`;
}

function estimateReleaseHeight(release, expanded = false) {
  if (!expanded) {
    const mobile = window.matchMedia?.("(max-width: 760px)").matches;
    return (mobile ? 148 : 122) + VIRTUAL_GAP;
  }

  const rowCount = release.totalRows || 8;
  const tableWeight = Math.min(280, rowCount * 18);
  const mobile = window.matchMedia?.("(max-width: 760px)").matches;
  const base = mobile ? 760 : 560;
  return base + tableWeight + VIRTUAL_GAP;
}

function getChart(id) {
  const element = document.getElementById(id);
  if (!element || !window.echarts) return null;

  let chart = chartRegistry.get(id);
  if (!chart) {
    chart = window.echarts.init(element, null, {
      renderer: "canvas",
      useDirtyRect: true,
    });
    chartRegistry.set(id, chart);
  }

  chart.resize();
  return chart;
}

function cssVar(name, fallback) {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

function themeColors() {
  return {
    ...COLORS,
    ink: cssVar("--ink-strong", COLORS.ink),
    muted: cssVar("--muted", COLORS.muted),
    line: cssVar("--line", COLORS.line),
    surface: cssVar("--surface", "#FFFFFF"),
    live: cssVar("--green-ink", COLORS.live),
    pending: cssVar("--yellow-ink", COLORS.pending),
    fixes: cssVar("--blue-ink", COLORS.fixes),
    improvements: cssVar("--red-ink", COLORS.improvements),
    unknown: cssVar("--unknown-ink", COLORS.unknown),
  };
}

function chartTextStyle() {
  const colors = themeColors();
  return {
    color: colors.ink,
    fontFamily: "Geist, SF Pro Display, Helvetica Neue, Arial, sans-serif",
    fontSize: 12,
  };
}

function donutOption(data, label) {
  const colors = themeColors();
  const cleanData = data.filter((item) => item.value > 0);
  const visibleData = cleanData.length
    ? cleanData
    : [{ name: "None", value: 1, itemStyle: { color: colors.unknown } }];

  return {
    backgroundColor: "transparent",
    animationDuration: 600,
    animationDurationUpdate: 520,
    tooltip: {
      trigger: "item",
      backgroundColor: colors.surface,
      borderColor: colors.line,
      textStyle: chartTextStyle(),
    },
    legend: {
      bottom: 0,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      textStyle: {
        color: colors.muted,
        fontFamily: "Geist Mono, SF Mono, Consolas, monospace",
        fontSize: 11,
      },
    },
    series: [
      {
        name: label,
        type: "pie",
        radius: ["58%", "76%"],
        center: ["50%", "45%"],
        avoidLabelOverlap: true,
        label: {
          color: colors.ink,
          fontFamily: "Geist Mono",
          fontSize: 11,
          formatter: "{c}",
        },
        emphasis: {
          scale: false,
          focus: "none",
          label: {
            show: true,
            color: colors.ink,
            fontFamily: "Geist Mono",
            fontSize: 11,
            formatter: "{c}",
          },
          labelLine: {
            show: true,
          },
        },
        blur: {
          itemStyle: {
            opacity: 1,
          },
        },
        labelLine: {
          length: 8,
          length2: 6,
          lineStyle: { color: colors.line },
        },
        itemStyle: {
          borderColor: colors.surface,
          borderWidth: 3,
        },
        data: visibleData,
      },
    ],
  };
}

function monthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "done";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

window.rodateApp = rodateApp;
