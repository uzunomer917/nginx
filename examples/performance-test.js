/**
 * CDN Proxy Performance Test Script
 * Bu script CDN'inizin performansını test eder
 * 
 * Kullanım: node examples/performance-test.js
 */

const https = require('https');
const http = require('http');

// CDN URL'inizi buraya yazın
const CDN_URL = 'https://cdn-proxy.your-subdomain.workers.dev';

// Test edilecek dosyalar
const testFiles = [
  '/test/image1.jpg',
  '/test/image2.jpg',
  '/test/image3.jpg',
  '/test/video.ts',
  '/test/thumbnail.jpg'
];

// Test ayarları
const config = {
  iterations: 10,        // Her dosya için kaç kez istek gönderilecek
  concurrency: 5,        // Aynı anda kaç istek gönderilecek
  warmupRequests: 2      // Cache warm-up için ilk istekler
};

class PerformanceTest {
  constructor() {
    this.results = {
      total: 0,
      success: 0,
      failed: 0,
      cacheHit: 0,
      cacheMiss: 0,
      totalTime: 0,
      times: [],
      errors: []
    };
  }

  async request(url) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const protocol = url.startsWith('https') ? https : http;

      protocol.get(url, (res) => {
        const endTime = Date.now();
        const duration = endTime - startTime;

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            duration,
            cacheStatus: res.headers['x-cache'] || 'UNKNOWN',
            size: parseInt(res.headers['content-length'] || '0'),
            headers: res.headers
          });
        });
      }).on('error', (err) => {
        reject(err);
      });
    });
  }

  async testFile(filePath, iteration) {
    const url = CDN_URL + filePath;
    
    try {
      const result = await this.request(url);
      
      this.results.total++;
      this.results.success++;
      this.results.totalTime += result.duration;
      this.results.times.push(result.duration);

      if (result.cacheStatus === 'HIT') {
        this.results.cacheHit++;
      } else if (result.cacheStatus === 'MISS') {
        this.results.cacheMiss++;
      }

      console.log(`✓ ${filePath} - ${result.duration}ms - ${result.cacheStatus} - ${(result.size / 1024).toFixed(2)} KB`);
      
      return result;
    } catch (error) {
      this.results.total++;
      this.results.failed++;
      this.results.errors.push({ file: filePath, error: error.message });
      console.log(`✗ ${filePath} - ERROR: ${error.message}`);
      return null;
    }
  }

  async warmup() {
    console.log('\n🔥 Warming up cache...\n');
    
    for (const file of testFiles) {
      for (let i = 0; i < config.warmupRequests; i++) {
        await this.testFile(file, i);
        await this.sleep(100); // 100ms delay
      }
    }
  }

  async runTest() {
    console.log('🚀 Starting Performance Test\n');
    console.log(`CDN URL: ${CDN_URL}`);
    console.log(`Test Files: ${testFiles.length}`);
    console.log(`Iterations: ${config.iterations}`);
    console.log(`Concurrency: ${config.concurrency}\n`);

    // Warmup
    await this.warmup();

    // Reset stats after warmup
    this.results = {
      total: 0,
      success: 0,
      failed: 0,
      cacheHit: 0,
      cacheMiss: 0,
      totalTime: 0,
      times: [],
      errors: []
    };

    console.log('\n📊 Running actual tests...\n');

    // Main test
    for (let iteration = 1; iteration <= config.iterations; iteration++) {
      console.log(`\n--- Iteration ${iteration}/${config.iterations} ---\n`);

      // Test her dosya için
      for (const file of testFiles) {
        await this.testFile(file, iteration);
        await this.sleep(50); // 50ms delay between requests
      }
    }

    this.printResults();
  }

  printResults() {
    console.log('\n' + '='.repeat(60));
    console.log('📈 TEST RESULTS');
    console.log('='.repeat(60) + '\n');

    console.log('Overall Statistics:');
    console.log(`  Total Requests:     ${this.results.total}`);
    console.log(`  Successful:         ${this.results.success} (${(this.results.success / this.results.total * 100).toFixed(1)}%)`);
    console.log(`  Failed:             ${this.results.failed} (${(this.results.failed / this.results.total * 100).toFixed(1)}%)`);
    console.log();

    console.log('Cache Statistics:');
    console.log(`  Cache HIT:          ${this.results.cacheHit} (${(this.results.cacheHit / this.results.total * 100).toFixed(1)}%)`);
    console.log(`  Cache MISS:         ${this.results.cacheMiss} (${(this.results.cacheMiss / this.results.total * 100).toFixed(1)}%)`);
    console.log();

    if (this.results.times.length > 0) {
      const sorted = this.results.times.sort((a, b) => a - b);
      const avg = this.results.totalTime / this.results.times.length;
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const median = sorted[Math.floor(sorted.length / 2)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];

      console.log('Response Time Statistics:');
      console.log(`  Average:            ${avg.toFixed(2)}ms`);
      console.log(`  Median:             ${median}ms`);
      console.log(`  Min:                ${min}ms`);
      console.log(`  Max:                ${max}ms`);
      console.log(`  95th Percentile:    ${p95}ms`);
      console.log(`  99th Percentile:    ${p99}ms`);
      console.log();
    }

    if (this.results.errors.length > 0) {
      console.log('Errors:');
      this.results.errors.forEach((err, i) => {
        console.log(`  ${i + 1}. ${err.file}: ${err.error}`);
      });
      console.log();
    }

    // Performance grade
    const avgTime = this.results.totalTime / this.results.times.length;
    const cacheHitRate = this.results.cacheHit / this.results.total * 100;
    
    let grade = 'F';
    let emoji = '😢';
    
    if (avgTime < 50 && cacheHitRate > 90) {
      grade = 'A+';
      emoji = '🏆';
    } else if (avgTime < 100 && cacheHitRate > 80) {
      grade = 'A';
      emoji = '🎉';
    } else if (avgTime < 200 && cacheHitRate > 70) {
      grade = 'B';
      emoji = '👍';
    } else if (avgTime < 500 && cacheHitRate > 50) {
      grade = 'C';
      emoji = '👌';
    } else if (avgTime < 1000) {
      grade = 'D';
      emoji = '🤔';
    }

    console.log('='.repeat(60));
    console.log(`${emoji} Performance Grade: ${grade}`);
    console.log('='.repeat(60));

    // Recommendations
    console.log('\n💡 Recommendations:\n');
    
    if (cacheHitRate < 80) {
      console.log('  ⚠️  Cache hit rate is low. Consider:');
      console.log('      - Increasing cache duration');
      console.log('      - Using immutable content with versioning');
      console.log('      - Checking origin cache headers');
    }
    
    if (avgTime > 100) {
      console.log('  ⚠️  Average response time is high. Consider:');
      console.log('      - Checking origin server performance');
      console.log('      - Using smaller file sizes');
      console.log('      - Optimizing images');
    }
    
    if (this.results.failed > 0) {
      console.log('  ⚠️  Some requests failed. Check:');
      console.log('      - Origin server availability');
      console.log('      - File paths are correct');
      console.log('      - CORS configuration');
    }

    if (cacheHitRate > 90 && avgTime < 100) {
      console.log('  ✅ Excellent performance! Your CDN is working great!');
    }

    console.log();
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Test'i çalıştır
async function main() {
  // Health check
  console.log('🔍 Checking CDN health...\n');
  
  const test = new PerformanceTest();
  
  try {
    const healthCheck = await test.request(CDN_URL + '/health');
    console.log(`✅ CDN is active (${healthCheck.duration}ms)\n`);
    
    // Ana test
    await test.runTest();
  } catch (error) {
    console.error('❌ Cannot connect to CDN:', error.message);
    console.error('\nPlease check:');
    console.error('  1. CDN_URL is correct');
    console.error('  2. CDN is deployed and running');
    console.error('  3. Network connection is working');
    process.exit(1);
  }
}

// Script çalıştırıldığında
if (require.main === module) {
  main().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });
}

module.exports = PerformanceTest;

