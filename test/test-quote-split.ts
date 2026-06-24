const { handleQuote } = await import('../src/skills/quotes.js');
export {};

async function run() {
  try {
    console.log('🚀 Testing WAVAX -> USDC Split Quote (100k)...');
    // Mainnet WAVAX: 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7
    // Mainnet USDC:  0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E
    const result = await handleQuote({
      tokenIn: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      tokenOut: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      amountIn: '100000',
      tokenInDecimals: 18,
      tokenOutDecimals: 6,
      useSplitRoutes: true,
      distributionPercent: 10,
      maxSplits: 3,
      minSplits: 1,
    });

    console.log('\n✅ SUCCESS! Received split quote:\n');
    console.log(JSON.stringify(result, null, 2));
  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message);
    if (error.stack) console.error(error.stack);
  }
}

run();
