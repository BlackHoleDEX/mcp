const { handlePoolYield } = await import('../src/skills/poolYield.js');
export {};

async function run() {
  try {
    // 1. Top 5 CL pools by LP emissions APR
    console.log('--- Top 5 CL pools (apr) ---');
    const topCL = await handlePoolYield({
      poolType: 'concentrated',
      topN: 5,
      sortBy: 'apr',
    });
    for (const pool of (topCL as any).data) {
      console.log(
        `${pool.symbol.padEnd(30)} APR=${String(pool.apr).padStart(8)}  vAPR=${String(pool.vapr).padStart(8)}  TVL=$${pool.tvlUsd}  fee=${pool.feePercent}%  type=${pool.poolType}`,
      );
    }
    console.log(`\nScanned: ${(topCL as any).meta.totalPoolsScanned} (v2=${(topCL as any).meta.v2PoolCount}, cl=${(topCL as any).meta.clPoolCount})`);

    // 2. Top 5 basic pools for comparison
    console.log('\n--- Top 5 Basic pools (apr) ---');
    const topV2 = await handlePoolYield({
      poolType: 'basic',
      topN: 5,
      sortBy: 'apr',
    });
    for (const pool of (topV2 as any).data) {
      console.log(
        `${pool.symbol.padEnd(30)} APR=${String(pool.apr).padStart(8)}  vAPR=${String(pool.vapr).padStart(8)}  TVL=$${pool.tvlUsd}  type=${pool.poolType}`,
      );
    }

    // 3. Search test
    console.log('\n--- Search "USDC" CL pools ---');
    const searchResult = await handlePoolYield({
      poolType: 'concentrated',
      search: 'USDC',
      topN: 3,
      sortBy: 'tvlUsd',
    });
    for (const pool of (searchResult as any).data) {
      console.log(
        `${pool.symbol.padEnd(30)} APR=${String(pool.apr).padStart(8)}  vAPR=${String(pool.vapr).padStart(8)}  TVL=$${pool.tvlUsd}`,
      );
    }

    // 4. APR range filter
    console.log('\n--- CL pools with APR > 10 ---');
    const highApr = await handlePoolYield({
      poolType: 'concentrated',
      apr: { min: 10 },
      topN: 5,
      sortBy: 'apr',
    });
    for (const pool of (highApr as any).data) {
      console.log(
        `${pool.symbol.padEnd(30)} APR=${String(pool.apr).padStart(8)}  vAPR=${String(pool.vapr).padStart(8)}  TVL=$${pool.tvlUsd}`,
      );
    }
    if ((highApr as any).data.length === 0) {
      console.log('  (no pools with APR > 10)');
    }

    // 5. Single CL pool lookup (pick first from topCL)
    const firstAddr = (topCL as any).data?.[0]?.pairAddress;
    if (firstAddr) {
      console.log(`\n--- Single pool: ${firstAddr} ---`);
      const single = await handlePoolYield({ poolAddress: firstAddr });
      console.log(JSON.stringify((single as any).data, null, 2));
    }

    console.log('\nDone.');
  } catch (error: any) {
    console.error('ERROR:', error.message);
    if (error.stack) console.error(error.stack);
  }
}

run();
