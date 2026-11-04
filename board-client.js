/* Shared-state client for the local Mingboard server; no browser credentials. */
(function (root, factory) {
  const client = factory();
  if (typeof module === "object" && module.exports) module.exports = client;
  else root.MingboardBoardClient = client;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const copy = (value) => JSON.parse(JSON.stringify(value));

  function createBoardClient({
    fetchImpl = (...args) => fetch(...args),
    onSnapshot = () => {},
    onError = () => {},
    onStatus = () => {},
    isActive = () => true,
    pollInterval = 1000
  } = {}) {
    let revision = null;
    let csrfToken = null;
    let user = null;
    let authoritative = null;
    let queued = null;
    let writing = null;
    let polling = null;
    let generation = 0;
    let connected = false;
    let stopped = false;
    let timer = null;

    const status = () => onStatus({ connected, saving: Boolean(writing || queued) });
    const headers = () => csrfToken ? { "X-Mingboard-Token": csrfToken } : {};

    async function request(path, options = {}) {
      const response = await fetchImpl(path, {
        cache: "no-store", credentials: "same-origin", ...options,
        headers: { ...headers(), ...options.headers }
      });
      const value = await response.json();
      if (!response.ok) {
        const error = new Error(value.error || `Mingboard returned ${response.status}.`);
        error.status = response.status;
        error.snapshot = value.snapshot;
        throw error;
      }
      return value;
    }

    function accept(snapshot, reason) {
      if (!snapshot || typeof snapshot.revision !== "string"
        || !Array.isArray(snapshot.board?.groups) || !Array.isArray(snapshot.board?.pins)
        || !snapshot.prefs || typeof snapshot.prefs !== "object") {
        throw new Error("Mingboard returned an invalid board.");
      }
      revision = snapshot.revision;
      authoritative = copy(snapshot);
      onSnapshot(copy(snapshot), reason);
    }

    async function load() {
      const session = await request("/api/session");
      if (stopped) return session;
      if (!session.user?.login || typeof session.csrfToken !== "string" || !session.csrfToken) {
        throw new Error("Mingboard returned an invalid session.");
      }
      if (user && user.login !== session.user.login) {
        throw new Error("The GitHub account changed. Reload Mingboard before continuing.");
      }
      csrfToken = session.csrfToken;
      user = session.user;
      accept(session.snapshot, "loaded");
      connected = true;
      status();
      return session;
    }

    async function drain() {
      if (writing) return writing;
      if (stopped || !connected || !queued) return;
      const value = queued;
      const sentGeneration = generation;
      queued = null;
      writing = (async () => {
        try {
          const snapshot = await request("/api/board", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...value, expectedRevision: revision })
          });
          if (stopped) return;
          if (generation === sentGeneration) accept(snapshot, "saved");
          else {
            revision = snapshot.revision;
            authoritative = copy(snapshot);
          }
        } catch (error) {
          if (stopped) return;
          queued = null;
          generation += 1;
          if (error.status === 409 && error.snapshot) {
            accept(error.snapshot, "conflict");
            onError("The board changed elsewhere. Your last edit was not saved; please try again.");
          } else {
            connected = false;
            if (authoritative) onSnapshot(copy(authoritative), "offline");
            onError(`Could not confirm the save: ${error.message} Reconnecting to the shared board…`);
          }
        } finally {
          writing = null;
          status();
        }
      })();
      status();
      await writing;
      if (queued && connected && !stopped) await drain();
    }

    function save(value) {
      if (stopped || !connected || revision === null) {
        if (authoritative && !stopped) onSnapshot(copy(authoritative), "offline");
        onError("The shared board is disconnected. Reconnect before making changes.");
        return false;
      }
      generation += 1;
      queued = copy(value);
      status();
      queueMicrotask(() => { void drain(); });
      return true;
    }

    async function flush() {
      while ((queued || writing) && !stopped && connected) {
        await drain();
      }
    }

    async function poll() {
      if (stopped || writing || queued || polling) return;
      const startedGeneration = generation;
      polling = (async () => {
        try {
          if (!connected) {
            await load();
            return;
          }
          const snapshot = await request("/api/board");
          if (stopped || !isActive() || generation !== startedGeneration || writing || queued) return;
          if (snapshot.revision !== revision) accept(snapshot, "external");
        } catch (error) {
          if (stopped || generation !== startedGeneration) return;
          const wasConnected = connected;
          connected = false;
          if (wasConnected) onError(`Shared board disconnected: ${error.message}`);
          status();
        } finally {
          polling = null;
        }
      })();
      return polling;
    }

    function start() {
      if (!timer && !stopped) timer = setInterval(() => {
        if (isActive()) void poll();
      }, pollInterval);
    }

    function stop() {
      stopped = true;
      generation += 1;
      queued = null;
      clearInterval(timer);
      timer = null;
    }

    return { load, save, flush, poll, start, stop, headers,
      isWritable: () => connected && !stopped,
      isBusy: () => Boolean(writing || queued) };
  }

  return { createBoardClient };
});
