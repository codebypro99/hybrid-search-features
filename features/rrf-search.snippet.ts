function rrfFuse(lists: ProductSearchHit[][], k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, idx) => {
      const contrib = 1 / (k + idx + 1); // idx+1 = 1-based rank
      fused.set(hit.id, (fused.get(hit.id) ?? 0) + contrib);
    });
  }
  return fused;
  
  private async searchWithRrf(
    trimmedQuery: string,
    boolQuery: any,
    filterClauses: any[],
    categoryPostFilter: any | undefined,
    from: number,
    pageSize: number,
  ): Promise<ProductSearchResult> {
    if (!this.es) throw new Error('Elasticsearch not configured');

    // Fetch enough docs from each source to cover the requested page after fusion.
    const window = Math.max(from + pageSize, 50);

    let vector: number[] | null = null;
    if (Date.now() >= this.embedderCircuitOpenUntil) {
      try {
        vector = await this.embedder.embedOne(trimmedQuery);
      } catch {
        vector = null; // Embedder error — does NOT trip the ES breaker.
      }
      // EmbedderClient reports failures as null, so treat null as a breaker failure too.
      if (vector) {
        this.embedderConsecutiveFailures = 0;
      } else {
        this.embedderConsecutiveFailures++;
        if (this.embedderConsecutiveFailures >= SearchService.EMBEDDER_FAILURE_THRESHOLD) {
          this.embedderCircuitOpenUntil = Date.now() + SearchService.EMBEDDER_OPEN_DURATION_MS;
          this.logger.warn(
            `Embedder circuit open for ${SearchService.EMBEDDER_OPEN_DURATION_MS}ms after ${this.embedderConsecutiveFailures} failures — Smart Search degrades to lexical-only.`,
          );
        }
      }
    }

    if (!vector) {
      // Embedder down — degrade gracefully to lexical-only.
      this.logger.debug('Smart Search: embedder unavailable — degrading to lexical-only.');
      try {
        const res = await this.es.search<any>({
          index: PRODUCTS_ALIAS,
          from,
          size: pageSize,
          track_total_hits: true,
          _source: false,
          query: boolQuery,
          post_filter: categoryPostFilter,
          aggs: CATEGORY_AGGS,
        });
        this.recordSuccess();
        const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? 0);
        const hits = res.hits.hits.map((h: any) => ({ id: h._id as string, score: h._score ?? 0 }));
        return { hits, total, categoryIds: extractCategoryIds(res) };
      } catch (err) {
        this.recordFailure(err as Error);
        throw err;
      }
    }

    // kNN has no post_filter concept — the category filter must be part of knn.filter,
    // otherwise vector hits would leak products from other folders into the fused page.
    const knnFilterClauses = categoryPostFilter ? [...filterClauses, categoryPostFilter] : filterClauses;

    // Run lexical and kNN searches in parallel.
    try {
      const [lexicalRes, vectorRes] = await Promise.all([
        this.es.search<any>({
          index: PRODUCTS_ALIAS,
          from: 0, // always fetch from start; pagination is applied after RRF fusion
          size: window,
          track_total_hits: true,
          _source: false,
          query: boolQuery,
          post_filter: categoryPostFilter,
          aggs: CATEGORY_AGGS,
        }),
        this.es.search<any>({
          index: PRODUCTS_ALIAS,
          size: window,
          _source: false,
          knn: {
            field: PRODUCTS_VECTOR_FIELD,
            query_vector: vector,
            k: window,
            // ES requires k <= num_candidates; window grows with deep pagination.
            num_candidates: Math.max(200, window),
            // ES 8: filters must be repeated inside knn — they are not applied globally.
            filter: knnFilterClauses.length ? knnFilterClauses : undefined,
          },
          // Aggregations on a kNN search run over the k retrieved neighbours — enough to
          // guarantee that every product visible after fusion has its category in the list.
          aggs: CATEGORY_AGGS,
        }),
      ]);

      this.recordSuccess();

      const lexicalHits: ProductSearchHit[] = lexicalRes.hits.hits.map((h: any) => ({
        id: h._id as string,
        score: h._score ?? 0,
      }));
      const vectorHits: ProductSearchHit[] = vectorRes.hits.hits.map((h: any) => ({
        id: h._id as string,
        score: h._score ?? 0,
      }));

      const fused = rrfFuse([lexicalHits, vectorHits]);
      const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]);
      const pageHits = sorted.slice(from, from + pageSize).map(([id, score]) => ({ id, score }));

      // Use the lexical query's total as the canonical "matches" count. Semantic neighbours
      // from kNN are augmentation — the lexical count is the well-defined set that satisfies
      // the filters and the query.
      const total =
        typeof lexicalRes.hits.total === 'number' ? lexicalRes.hits.total : (lexicalRes.hits.total?.value ?? 0);

      // Union of lexical and kNN categories: a product surfaced purely by semantic
      // similarity must still have its category present in the panel. (total stays
      // lexical-only — kNN returns exactly k neighbours and has no bounded match set.)
      const categoryIds = [...new Set([...extractCategoryIds(lexicalRes), ...extractCategoryIds(vectorRes)])];
      return { hits: pageHits, total, categoryIds };
    } catch (err) {
      this.recordFailure(err as Error);
      throw err;
    }

