const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const user_agents = require("./config/userAgents");
const settings = require("./config/config.js");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson, updateEnv, decodeJWT, getRandomElement } = require("./utils.js");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { checkBaseUrl } = require("./checkAPI");
const { headers } = require("./core/header.js");
const { showBanner } = require("./core/banner.js");
const { sovleCaptcha } = require("./captcha.js");

class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL, tokens) {
    this.headers = headers;
    this.baseURL = baseURL;
    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = tokens[this.session_name] || null;
    this.tokens = tokens;
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    console.log(`[Tài khoản ${this.accountIndex + 1}] Tạo user agent...`.blue);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.itemData.email;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[Account ${this.accountIndex + 1}][${this.itemData.email}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 1,
      isAuth: false,
      headers: {},
    }
  ) {
    const { retries, isAuth } = options;

    const headers = {
      ...this.headers,
      ...options.headers,
    };

    if (!isAuth) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    let currRetries = 0,
      success = false;
    do {
      try {
        const response = await axios({
          method,
          url: `${url}`,
          data,
          headers,
          timeout: 30000,
          ...(proxyAgent ? { httpsAgent: proxyAgent } : {}),
        });
        success = true;
        if (response?.data?.metadata) return { status: response.data.statusCode, success: true, data: response.data.metadata };
        return { success: true, data: response.data, status: response.status };
      } catch (error) {
        const errMesss = error.response.data.message || error.response.data.error || error.message;
        if (error.status == 429) {
          this.log(`Many requests failed 429 | Waiting 60s...`, "warning");
          await sleep(60);
        }
        if (error.status == 401) {
          const token = await this.getValidToken(true);
          if (!token) {
            process.exit(1);
          }
          this.token = token;
          return this.makeRequest(url, method, data, options);
        }
        if (error.status == 400 && url.includes("user/task")) {
          // this.log(`Invalid request for ${url}, maybe have new update from server | contact: https://t.me/airdrophuntersieutoc to get new update!`, "error");
          return { success: false, status: error.status, error: errMesss };
        }
        this.log(`Yêu cầu thất bại: ${url} | ${errMesss} | đang thử lại...`, "warning");
        success = false;
        await sleep(settings.DELAY_BETWEEN_REQUESTS);
        if (currRetries == retries) return { status: error.status, success: false, error: errMesss };
      }
      currRetries++;
    } while (currRetries <= retries && !success);
  }

  async auth() {
    const tokenCapthca = await sovleCaptcha();
    if (!tokenCapthca) {
      this.log("Can't get token captcha");
      return { success: false, error: "Can't get token captcha" };
    }
    const payload = {
      email: this.itemData.email,
      password: this.itemData.password,
      captcha: tokenCapthca,
    };
    return this.makeRequest(`${this.baseURL}/auth/login`, "post", payload, { isAuth: true });
  }

  async getUserData() {
    return this.makeRequest(`${this.baseURL}/user/me`, "get");
  }

  async dailyEarning() {
    return this.makeRequest(`${this.baseURL}/daily-earnings`, "get");
  }

  async checkin() {
    return this.makeRequest(`${this.baseURL}/user/checkin`, "post");
  }

  async ping() {
    return this.makeRequest(
      `${this.baseURL}/user/nodes/ping`,
      "post",
      { type: "extension" },
      {
        headers: {
          Origin: "chrome-extension://jbmdcnidiaknboflpljihfnbonjgegah",
        },
      }
    );
  }

  async getTasks() {
    return this.makeRequest(`${this.baseURL}/tasks`, "get");
  }

  async completeTask(payload) {
    return this.makeRequest(`${this.baseURL}/user/task`, "post", payload);
  }

  async handleTasks(completedTasks) {
    const tasksRes = await this.getTasks();
    if (!tasksRes.success) {
      this.log(`Can't get tasks | ${JSON.stringify(tasksRes || {})}`, "warning");
      return;
    }
    const tasks = tasksRes.data.filter((t) => !completedTasks.includes(t.code) && !settings.SKIP_TASKS.includes(t.code));

    for (const task of tasks) {
      const taskRes = await this.completeTask({ taskId: task.code });
      if (taskRes.success) {
        this.log(`Complete task ${task.code} | ${task.title} success`, "success");
      } else {
        this.log(`Can't complete task ${task.code} | ${task.title} | ${JSON.stringify(taskRes || {})}`, "warning");
      }
    }
  }

  async handleCheckin() {
    const checkinRes = await this.checkin();
    if (checkinRes.success) {
      this.log("Checkin success!", "success");
    } else {
      this.log(`Can't checkin | ${JSON.stringify(checkinRes || {})}`, "warning");
    }
  }

  async handlePing() {
    const pingRes = await this.ping();
    if (pingRes.success) {
      this.log("Ping success!", "success");
    } else {
      this.log(`Can't ping | ${JSON.stringify(pingRes || {})}`, "warning");
    }
  }

  async isCheckin(time) {
    if (!time) return false;
    const today = new Date();
    const date = new Date(time);
    return today.getDate() === date.getDate() && today.getMonth() === date.getMonth() && today.getFullYear() === date.getFullYear();
  }

  async getValidToken(isNew = false) {
    const existingToken = this.token;
    const isExp = isTokenExpired(existingToken);
    if (existingToken && !isNew && !isExp) {
      this.log("Using valid token", "success");
      return existingToken;
    } else {
      this.log("No found token or experied, trying get new token...", "warning");
      const newToken = await this.auth();
      if (newToken.success && newToken.data?.accessToken) {
        this.log("Get new token success!", "success");
        saveJson(this.session_name, newToken.data.accessToken, "tokens.json");
        return newToken.data.accessToken;
      }
      this.log("Can't get new token...", "warning");
      return null;
    }
  }

  async handleSyncData() {
    let userData = { success: false, data: null },
      retries = 0;
    do {
      userData = await this.getUserData();
      if (userData?.success) break;
      retries++;
    } while (retries < 2);
    if (userData.success) {
      const totalPoints = userData.data.nodes.reduce((acc, node) => acc + node.todayPoint, 0);
      this.log(`Total Nodes ${userData.data.nodes.length}: Received today: ${totalPoints.toFixed(2)} | Total points: ${userData.data.rewardPoint}`, "custom");
    } else {
      return this.log("Can't sync new data...skipping", "warning");
    }
    return userData;
  }

  async runAccount() {
    const accountIndex = this.accountIndex;
    this.session_name = this.itemData.email;
    this.token = this.tokens[this.session_name];
    this.#set_headers();
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Tài khoản ${accountIndex + 1} | ${this.proxyIP} | Bắt đầu sau ${timesleep} giây...`.green);
      await sleep(timesleep);
    }

    const token = await this.getValidToken();
    if (!token) return;
    this.token = token;
    const userData = await this.handleSyncData();
    if (userData.success) {
      if (settings.AUTO_TASK) {
        await this.handleTasks(userData.data.socialTask || []);
        await sleep(1);
      }
      if (!this.isCheckin(userData.data.lastCheckinAt)) {
        await this.handleCheckin();
        await sleep(1);
      }
      await this.handlePing();
      await sleep(1);
      await this.handleSyncData();
    } else {
      return this.log("Can't get use info...skipping", "error");
    }
  }
}

async function runWorker(workerData) {
  const { itemData, accountIndex, proxy, hasIDAPI, tokens } = workerData;
  const to = new ClientAPI(itemData, accountIndex, proxy, hasIDAPI, tokens);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  showBanner();
  // fs.writeFile("./tokens.json", JSON.stringify({}), (err) => {});
  // await sleep(1);
  const data = loadData("accounts.txt");
  const proxies = loadData("proxy.txt");
  const tokens = require("./tokens.json");
  if (data.length == 0 || (data.length > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy và data phải bằng nhau.".red);
    console.log(`Data: ${data.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }
  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const { endpoint, message } = await checkBaseUrl();
  if (!endpoint) return console.log(`Không thể tìm thấy ID API, thử lại sau!`.red);
  console.log(`${message}`.yellow);

  const itemDatas = data.map((val, i) => {
    const [email, password] = val.split("|");
    const proxy = proxies[i] || null;
    const token = tokens[email] ? tokens[email].replace('"', "") : null;
    const item = { email, password, proxy, token, lastPingTimestamp: 0 };
    new ClientAPI(item, i, proxies[i], endpoint, tokens).createUserAgent();
    return item;
  });
  await sleep(1);
  while (true) {
    let currentIndex = 0;
    const errors = [];
    while (currentIndex < data.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, data.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI: endpoint,
            itemData: itemDatas[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex],
            tokens,
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              if (code !== 0) {
                errors.push(`Worker cho tài khoản ${currentIndex} thoát với mã: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < data.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    await sleep(3);
    console.log(`=============${new Date().toLocaleString()} | Hoàn thành tất cả tài khoản | Chờ ${settings.TIME_SLEEP} phút=============`.magenta);
    showBanner();
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}
