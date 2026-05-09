const { chromium } = require('/opt/homebrew/lib/node_modules/@playwright/test/node_modules/playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = '/Users/ironman/.openclaw/workspace/beerdistribution/tests/screenshots';

async function run() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // ── PAGE 1: Player page ──────────────────────────────────────────────────
  const playerPage = await context.newPage();

  console.log('\n=== STEP 1: Open http://localhost:3000 ===');
  await playerPage.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await playerPage.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-player-initial.png') });
  console.log('Screenshot saved: 01-player-initial.png');

  // Describe what is visible
  const loginModalVisible = await playerPage.locator('#loginModal').isVisible();
  const loginErrHidden = await playerPage.locator('#loginErr').isHidden();
  const btnLoginText = await playerPage.locator('#btnLogin').textContent();
  console.log(`Login modal visible: ${loginModalVisible}`);
  console.log(`Login error hidden: ${loginErrHidden}`);
  console.log(`Login button text: "${btnLoginText}"`);

  // ── STEP 2: Try login with "testplayer1" ─────────────────────────────────
  console.log('\n=== STEP 2: Enter username "testplayer1" and click login ===');
  // Wait for socket.io to connect (conn bar shows 🟢 在线)
  await playerPage.waitForFunction(() => {
    const bar = document.getElementById('connBar');
    return bar && bar.textContent.includes('在线');
  }, { timeout: 10000 }).catch(() => console.log('Warning: connBar did not show 在线 within 10s'));

  const connBarText = await playerPage.locator('#connBar').textContent();
  console.log(`Connection bar: "${connBarText}"`);

  await playerPage.locator('#usernameInput').fill('testplayer1');
  await playerPage.locator('#btnLogin').click();

  // Wait for response: either error shown, main app shown, or 5s timeout
  await Promise.race([
    playerPage.waitForFunction(() => !document.getElementById('loginErr').hidden, { timeout: 5000 }),
    playerPage.waitForFunction(() => !document.getElementById('mainApp').hidden, { timeout: 5000 }),
  ]).catch(() => console.log('No response within 5s — socket may not have responded'));
  await playerPage.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-player-after-login-attempt.png') });
  console.log('Screenshot saved: 02-player-after-login-attempt.png');

  const errVisible = await playerPage.locator('#loginErr').isVisible();
  const errHiddenAttr = await playerPage.locator('#loginErr').getAttribute('hidden');
  const errText2 = await playerPage.locator('#loginErr').textContent();
  const mainAppVisible = await playerPage.locator('#mainApp').isVisible();
  const modalStillVisible = await playerPage.locator('#loginModal').isVisible();

  console.log(`#loginErr isVisible: ${errVisible}, hidden attr: ${JSON.stringify(errHiddenAttr)}, text: "${errText2}"`);
  console.log(`#mainApp isVisible: ${mainAppVisible}`);
  console.log(`#loginModal isVisible: ${modalStillVisible}`);

  if (errVisible) {
    console.log(`Login error shown: "${errText2}"`);
  }
  if (mainAppVisible) {
    const statusText = await playerPage.locator('#participants').textContent();
    console.log(`Main app visible. Status: "${statusText}"`);
  }
  if (modalStillVisible && !errVisible) {
    console.log('Login modal still visible, no error shown — login may be pending or game not started');
  }

  // ── PAGE 2: Admin page ───────────────────────────────────────────────────
  console.log('\n=== STEP 3: Open http://localhost:3000/admin.html ===');
  const adminPage = await context.newPage();
  await adminPage.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await adminPage.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-admin-initial.png') });
  console.log('Screenshot saved: 03-admin-initial.png');

  // Describe admin page state
  const adminLoginModalVisible2 = await adminPage.locator('#adminLogin').isVisible();
  const adminPanelVisible = await adminPage.locator('#adminApp').isVisible();
  console.log(`Admin login modal (#adminLogin) visible: ${adminLoginModalVisible2}`);
  console.log(`Admin app (#adminApp) visible: ${adminPanelVisible}`);

  // ── STEP 4: Admin login ──────────────────────────────────────────────────
  console.log('\n=== STEP 4: Enter admin password "change-me" and login ===');
  // Admin login modal is #adminLogin, password input is #passwordInput, button is #btnAdmin
  const adminLoginModalVisible = await adminPage.locator('#adminLogin').isVisible();
  console.log(`Admin login modal (#adminLogin) visible: ${adminLoginModalVisible}`);

  const adminPasswordInput = adminPage.locator('#passwordInput');
  const adminPasswordExists = await adminPasswordInput.count() > 0;

  if (adminPasswordExists) {
    await adminPasswordInput.fill('change-me');
    await adminPage.locator('#btnAdmin').click();
    await adminPage.waitForTimeout(2000);
  } else {
    console.log('No #passwordInput found on admin page');
    const bodyText = await adminPage.locator('body').textContent();
    console.log('Admin page body (first 500 chars):', bodyText.substring(0, 500));
  }

  await adminPage.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-admin-after-login.png') });
  console.log('Screenshot saved: 04-admin-after-login.png');

  const adminLoginGone = await adminPage.locator('#adminLogin').isHidden();
  const adminStatusText = await adminPage.locator('#adminStatus').textContent().catch(() => 'N/A');
  const wrongPassVisible = await adminPage.locator('#wrongPass').isVisible();
  console.log(`Admin login modal hidden after login: ${adminLoginGone}`);
  console.log(`Admin status text: "${adminStatusText}"`);
  if (wrongPassVisible) console.log('Wrong password error shown!');

  // ── STEP 5: Start game if not started ────────────────────────────────────
  console.log('\n=== STEP 5: Check for "开始游戏" button ===');
  const startGameBtn = adminPage.locator('button').filter({ hasText: '开始游戏' });
  const startGameBtnExists = await startGameBtn.count() > 0;
  console.log(`"开始游戏" button found: ${startGameBtnExists}`);

  if (startGameBtnExists) {
    const isDisabled = await startGameBtn.isDisabled();
    console.log(`"开始游戏" button disabled: ${isDisabled}`);
    if (!isDisabled) {
      await startGameBtn.click();
      await adminPage.waitForTimeout(1500);
      console.log('Clicked "开始游戏"');
    } else {
      console.log('"开始游戏" button is disabled — game may already be running or not enough players');
    }
  }

  await adminPage.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-admin-after-start.png') });
  console.log('Screenshot saved: 05-admin-after-start.png');

  // ── STEP 6: Back to player page, try login again ─────────────────────────
  console.log('\n=== STEP 6: Back to player page, try login again ===');
  await playerPage.bringToFront();

  // If modal is gone (already logged in), just screenshot
  const modalNowVisible = await playerPage.locator('#loginModal').isVisible();
  if (modalNowVisible) {
    // Clear and re-enter username
    await playerPage.locator('#usernameInput').fill('');
    await playerPage.locator('#usernameInput').fill('testplayer1');
    await playerPage.locator('#btnLogin').click();
    // Wait for response
    await Promise.race([
      playerPage.waitForFunction(() => !document.getElementById('loginErr').hidden, { timeout: 5000 }),
      playerPage.waitForFunction(() => !document.getElementById('mainApp').hidden, { timeout: 5000 }),
    ]).catch(() => console.log('No response within 5s on final attempt'));
  }

  await playerPage.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-player-final.png') });
  console.log('Screenshot saved: 06-player-final.png');

  console.log('\n=== FINAL STATE ===');
  const finalErrVisible = await playerPage.locator('#loginErr').isVisible();
  const finalErrText = await playerPage.locator('#loginErr').textContent();
  const finalErrHiddenAttr = await playerPage.locator('#loginErr').getAttribute('hidden');
  const finalMainAppVisible = await playerPage.locator('#mainApp').isVisible();
  const finalModalVisible = await playerPage.locator('#loginModal').isVisible();

  console.log(`#loginErr isVisible: ${finalErrVisible}, hidden attr: ${JSON.stringify(finalErrHiddenAttr)}, text: "${finalErrText}"`);
  if (finalErrVisible) {
    console.log(`Error message: "${finalErrText}"`);
  }
  if (finalMainAppVisible) {
    const statusText = await playerPage.locator('#participants').textContent();
    const userRoleText = await playerPage.locator('#userRole').textContent();
    const usernameText = await playerPage.locator('#username').textContent();
    console.log(`Main app visible. Status: "${statusText}"`);
    console.log(`User role: "${userRoleText}", Username: "${usernameText}"`);
  }
  if (finalModalVisible && !finalErrVisible && !finalMainAppVisible) {
    console.log('Login modal still showing, no error, no main app — login did not complete');
  }

  await browser.close();
  console.log('\nAll screenshots saved to:', SCREENSHOTS_DIR);
}

run().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
