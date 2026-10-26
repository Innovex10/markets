"use strict";

const $ = selector => document.querySelector(selector);

const screens = [
  "authScreen",
  "welcomeScreen",
  "forexScreen",
  "cryptoScreen",
  "packagesScreen",
  "checkoutScreen",
  "dashboardScreen"
];

const packageDefinitions = {
  forex_basic: {
    name: "Forex Essentials",
    category: "forex",
    price: 200,
    description: "Entry-level access to forex market information."
  },
  forex_plus: {
    name: "Forex Professional",
    category: "forex",
    price: 500,
    description: "Expanded access to currency-market information."
  },
  forex_elite: {
    name: "Forex Advanced",
    category: "forex",
    price: 1000,
    description: "The highest forex information-access package."
  },
  crypto_basic: {
    name: "Crypto Essentials",
    category: "crypto",
    price: 200,
    description: "Entry-level access to crypto market information."
  },
  crypto_plus: {
    name: "Crypto Professional",
    category: "crypto",
    price: 500,
    description: "Expanded access to cryptocurrency information."
  },
  crypto_elite: {
    name: "Crypto Advanced",
    category: "crypto",
    price: 1000,
    description: "The highest crypto information-access package."
  },
  complete: {
    name: "Forex and Crypto Access",
    category: "both",
    price: 1000,
    description: "Access to both forex and cryptocurrency information."
  }
};

const symbols = {
  forex: [
    ["EUR/USD", "Euro / US Dollar"],
    ["GBP/USD", "British Pound / US Dollar"],
    ["USD/JPY", "US Dollar / Japanese Yen"],
    ["AUD/USD", "Australian Dollar / US Dollar"],
    ["USD/KES", "US Dollar / Kenyan Shilling"]
  ],
  crypto: [
    ["BTC/USD", "Bitcoin"],
    ["ETH/USD", "Ethereum"],
    ["SOL/USD", "Solana"],
    ["XRP/USD", "XRP"]
  ]
};

let currentUser = null;
let currentCategory = "forex";
let selectedPackageId = null;
let currentPaymentId = null;
let paymentPollTimer = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  let data;

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong. Please try again.");
  }

  return data;
}

function setMessage(element, message, isError = false) {
  if (!element) return;

  element.textContent = message;
  element.classList.toggle("error", isError);
}

function showScreen(screenId) {
  for (const id of screens) {
    const screen = document.getElementById(id);
    if (screen) screen.classList.toggle("hidden", id !== screenId);
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setBusy(button, busy, busyText = "Please wait...") {
  if (!button) return;

  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function formatMoney(amount) {
  return `KSh ${Number(amount).toLocaleString("en-KE")}`;
}

function authTab(tab) {
  document.querySelectorAll("[data-auth-tab]").forEach(button => {
    button.classList.toggle("active", button.dataset.authTab === tab);
  });

  $("#loginForm").classList.toggle("hidden", tab !== "login");
  $("#registerForm").classList.toggle("hidden", tab !== "register");
  setMessage($("#authMessage"), "");
}

document.querySelectorAll("[data-auth-tab]").forEach(button => {
  button.addEventListener("click", () => authTab(button.dataset.authTab));
});

async function register(event) {
  event.preventDefault();

  const button = $("#registerForm button[type='submit']");
  setMessage($("#authMessage"), "");
  setBusy(button, true, "Creating account...");

  try {
    const result = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: $("#registerName").value,
        email: $("#registerEmail").value,
        phone: $("#registerPhone").value,
        password: $("#registerPassword").value
      })
    });

    currentUser = result.user;
    $("#registerForm").reset();
    await openDashboard();
  } catch (error) {
    setMessage($("#authMessage"), error.message, true);
  } finally {
    setBusy(button, false);
  }
}

async function login(event) {
  event.preventDefault();

  const button = $("#loginForm button[type='submit']");
  setMessage($("#authMessage"), "");
  setBusy(button, true, "Signing in...");

  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("#loginEmail").value,
        password: $("#loginPassword").value
      })
    });

    currentUser = result.user;
    $("#loginForm").reset();
    await openDashboard(result.entitlements);
  } catch (error) {
    setMessage($("#authMessage"), error.message, true);
  } finally {
    setBusy(button, false);
  }
}

$("#registerForm").addEventListener("submit", register);
$("#loginForm").addEventListener("submit", login);

async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // Clear the local screen even if the network request fails.
  }

  stopPaymentPolling();
  currentUser = null;
  selectedPackageId = null;
  currentPaymentId = null;

  $("#signOutButton").classList.add("hidden");
  showScreen("authScreen");
  authTab("login");
}

$("#signOutButton").addEventListener("click", signOut);

function setAuthenticated(user) {
  currentUser = user;
  $("#signOutButton").classList.remove("hidden");
}

async function openDashboard(existingEntitlements) {
  if (!currentUser) return;

  setAuthenticated(currentUser);

  $("#customerName").textContent = currentUser.name;

  let entitlements = existingEntitlements;

  if (!entitlements) {
    const data = await api("/api/me");
    entitlements = data.entitlements;
    currentUser = data.user;
    $("#customerName").textContent = currentUser.name;
  }

  renderEntitlements(entitlements || []);
  showScreen("dashboardScreen");
}

function renderEntitlements(entitlements) {
  const list = $("#entitlementList");
  list.replaceChildren();

  $("#activePackages").textContent = String(entitlements.length);
  $("#accountStatus").textContent = "Registered";

  if (!entitlements.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      "You have no active packages yet. Browse the markets to choose one.";
    list.appendChild(empty);
    return;
  }

  $("#accountStatus").textContent = "Access active";

  for (const item of entitlements) {
    const card = document.createElement("div");
    card.className = "entitlement-item";

    const title = document.createElement("strong");
    title.textContent = item.name;

    const details = document.createElement("span");
    details.textContent =
      `${item.category.toUpperCase()} · ${formatMoney(item.amount)} · Access confirmed`;

    card.append(title, details);
    list.appendChild(card);
  }
}

$("#browseMarketsButton").addEventListener("click", () => {
  showScreen("welcomeScreen");
});

document.querySelectorAll("[data-next]").forEach(button => {
  button.addEventListener("click", async () => {
    const next = button.dataset.next;

    if (next === "packagesScreen") {
      currentCategory = button.dataset.category || "forex";
      await renderPackages(currentCategory);
      return;
    }

    showScreen(next);
  });
});

document.querySelectorAll("[data-back]").forEach(button => {
  button.addEventListener("click", () => showScreen(button.dataset.back));
});

$("#chooseBothButton").addEventListener("click", async () => {
  currentCategory = "both";
  await renderPackages("both");
});

$("#packageBackButton").addEventListener("click", () => {
  if (currentCategory === "crypto") {
    showScreen("cryptoScreen");
  } else if (currentCategory === "both") {
    showScreen("welcomeScreen");
  } else {
    showScreen("forexScreen");
  }
});

async function renderPackages(category) {
  const grid = $("#packageGrid");
  grid.replaceChildren();

  const heading = document.createElement("p");
  heading.className = "muted";
  heading.textContent = "Loading available packages...";
  grid.appendChild(heading);

  showScreen("packagesScreen");
  setMessage($("#packageMessage"), "");

  try {
    const result = await api("/api/packages");
    grid.replaceChildren();

    const filtered = result.packages.filter(item =>
      category === "both"
        ? item.category === "both"
        : item.category === category
    );

    for (const item of filtered) {
      const definition = packageDefinitions[item.id];
      if (!definition) continue;

      const card = document.createElement("article");
      card.className = "package-card";

      if (item.amount === 1000) card.classList.add("featured");

      const badge = document.createElement("span");
      badge.className = "eyebrow";
      badge.textContent = item.category === "both"
        ? "ALL MARKETS"
        : item.category.toUpperCase();

      const title = document.createElement("h2");
      title.textContent = item.name;

      const price = document.createElement("div");
      price.className = "package-price";
      price.textContent = formatMoney(item.amount);

      const description = document.createElement("p");
      description.textContent = definition.description;

      const list = document.createElement("ul");
      const features = [
        "Account-based access",
        "Market information where available",
        "M-Pesa payment confirmation"
      ];

      for (const feature of features) {
        const li = document.createElement("li");
        li.textContent = feature;
        list.appendChild(li);
      }

      const button = document.createElement("button");
      button.className = "button button-primary";
      button.type = "button";
      button.textContent = "Choose package →";
      button.addEventListener("click", () => choosePackage(item.id));

      card.append(badge, title, price, description, list, button);
      grid.appendChild(card);
    }
  } catch (error) {
    setMessage($("#packageMessage"), error.message, true);
    grid.replaceChildren();
  }
}

function choosePackage(packageId) {
  const item = packageDefinitions[packageId];

  if (!item) {
    setMessage($("#packageMessage"), "This package is unavailable.", true);
    return;
  }

  selectedPackageId = packageId;

  $("#orderName").textContent = item.name;
  $("#orderDescription").textContent = item.description;
  $("#orderPrice").textContent = formatMoney(item.price);
  $("#orderTotal").textContent = formatMoney(item.price);
  $("#checkoutPhone").value = currentUser?.phone || "";

  setMessage($("#checkoutMessage"), "");
  showScreen("checkoutScreen");
}

$("#checkoutForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (!selectedPackageId) {
    setMessage($("#checkoutMessage"), "Select a package first.", true);
    return;
  }

  const button = $("#checkoutForm button[type='submit']");
  setMessage($("#checkoutMessage"), "");
  setBusy(button, true, "Requesting payment...");

  try {
    const result = await api("/api/payments/mpesa", {
      method: "POST",
      body: JSON.stringify({
        packageId: selectedPackageId,
        phone: $("#checkoutPhone").value
      })
    });

    currentPaymentId = result.paymentId;

    setMessage(
      $("#checkoutMessage"),
      result.customerMessage ||
        "Payment request sent. Check your phone and enter your M-Pesa PIN only in the official phone prompt."
    );

    startPaymentPolling(currentPaymentId);
  } catch (error) {
    setMessage($("#checkoutMessage"), error.message, true);
  } finally {
    setBusy(button, false);
  }
});

function stopPaymentPolling() {
  if (paymentPollTimer) {
    clearTimeout(paymentPollTimer);
    paymentPollTimer = null;
  }
}

function startPaymentPolling(paymentId) {
  stopPaymentPolling();

  const startedAt = Date.now();

  async function checkStatus() {
    if (currentPaymentId !== paymentId) return;

    try {
      const result = await api(`/api/payments/${encodeURIComponent(paymentId)}`);
      const payment = result.payment;

      if (payment.status === "paid") {
        stopPaymentPolling();
        currentPaymentId = null;

        setMessage(
          $("#checkoutMessage"),
          `Payment confirmed. Receipt: ${payment.mpesa_receipt || "recorded"}.`
        );

        const data = await api("/api/me");
        currentUser = data.user;
        await openDashboard(data.entitlements);
        return;
      }

      if (payment.status === "failed") {
        stopPaymentPolling();
        setMessage(
          $("#checkoutMessage"),
          "The payment was not completed. Return to checkout and try again.",
          true
        );
        return;
      }

      if (Date.now() - startedAt > 120000) {
        stopPaymentPolling();
        setMessage(
          $("#checkoutMessage"),
          "Payment is still awaiting confirmation. You can check your account again shortly. Do not pay twice without checking the transaction status."
        );
        return;
      }
    } catch (error) {
      setMessage($("#checkoutMessage"), error.message, true);
    }

    paymentPollTimer = setTimeout(checkStatus, 3000);
  }

  checkStatus();
}

function updateSymbolOptions() {
  const category = $("#marketCategory").value;
  const select = $("#marketSymbol");

  select.replaceChildren();

  for (const [symbol, name] of symbols[category]) {
    const option = document.createElement("option");
    option.value = symbol;
    option.textContent = `${symbol} — ${name}`;
    select.appendChild(option);
  }

  $("#quoteResult").replaceChildren();

  const label = document.createElement("span");
  label.textContent = "Market quote";

  const price = document.createElement("strong");
  price.textContent = "—";

  const note = document.createElement("small");
  note.textContent = "Request a quote to view provider data.";

  $("#quoteResult").append(label, price, note);
}

$("#marketCategory").addEventListener("change", updateSymbolOptions);
updateSymbolOptions();

$("#loadQuoteButton").addEventListener("click", async () => {
  const button = $("#loadQuoteButton");
  const category = $("#marketCategory").value;
  const symbol = $("#marketSymbol").value;
  const resultBox = $("#quoteResult");

  setBusy(button, true, "Loading quote...");

  try {
    const result = await api(
      `/api/markets/quote?category=${encodeURIComponent(category)}&symbol=${encodeURIComponent(symbol)}`
    );

    resultBox.replaceChildren();

    const label = document.createElement("span");
    label.textContent = result.symbol;

    const price = document.createElement("strong");
    price.textContent = Number(result.price).toLocaleString("en-US", {
      maximumFractionDigits: 8
    });

    const note = document.createElement("small");
    note.textContent = `Source: ${result.source}. Retrieved just now.`;

    resultBox.append(label, price, note);
  } catch (error) {
    resultBox.replaceChildren();

    const message = document.createElement("span");
    message.textContent = "Market quote unavailable";

    const detail = document.createElement("small");
    detail.textContent = error.message;

    resultBox.append(message, detail);
  } finally {
    setBusy(button, false);
  }
});

async function initialize() {
  try {
    const result = await api("/api/me");
    currentUser = result.user;
    await openDashboard(result.entitlements);
  } catch {
    currentUser = null;
    $("#signOutButton").classList.add("hidden");
    showScreen("authScreen");
  }
}

initialize();