"use strict";

const STORAGE_KEY = "raceSplitAssistant.courses.v1";
const ACTIVE_KEY = "raceSplitAssistant.activeRun.v1";

// Listes de référence utilisées par les formulaires et les imports JSON.
const zoneTypes = [
  "Départ",
  "Plat",
  "Montée",
  "Descente",
  "Ravito",
  "Zone difficile",
  "Relance",
  "Finish",
  "Autre"
];

const strategies = [
  "Course continue",
  "Marche rapide autorisée",
  "Course/marche",
  "Descente contrôlée",
  "Relance progressive",
  "Finish au mental",
  "Libre"
];

const courseTypes = ["Route", "Trail", "Urban Trail", "Entraînement", "Autre"];

let courses = [];
let activeRun = null;
let liveTick = null;
let wakeLock = null;
let lastMessage = "";

const app = document.querySelector("#app");
const screenTitle = document.querySelector("#screen-title");

document.addEventListener("DOMContentLoaded", init);
window.addEventListener("hashchange", renderRoute);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && location.hash === "#live") {
    requestWakeLock();
  }
});

function init() {
  courses = loadCourses();
  activeRun = loadActiveRun();

  // Au premier lancement, une stratégie complète est disponible immédiatement.
  if (courses.length === 0) {
    courses = [createExampleCourse()];
    saveCourses();
  }

  bindGlobalActions();
  registerServiceWorker();

  if (activeRun && activeRun.status !== "finished") {
    if (location.hash === "#resume") {
      renderRoute();
    } else {
      location.hash = "#resume";
    }
  } else if (!location.hash) {
    location.hash = "#home";
  } else {
    renderRoute();
  }
}

function bindGlobalActions() {
  document.body.addEventListener("click", (event) => {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      if (location.hash === "#live" && routeButton.dataset.route === "#home") {
        confirmLeaveLiveToMenu();
        return;
      }
      location.hash = routeButton.dataset.route;
      return;
    }

    const openActive = event.target.closest("[data-action='open-active']");
    if (openActive) {
      if (activeRun && activeRun.status !== "finished") {
        location.hash = "#live";
      } else {
        location.hash = "#home";
      }
    }
  });
}

function confirmLeaveLiveToMenu() {
  confirmDialog("Revenir au menu ? La course restera sauvegardée et pourra être reprise.", () => {
    location.hash = "#home";
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (error) {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  if (!wakeLock) return;
  wakeLock.release().catch(() => {});
  wakeLock = null;
}

function renderRoute() {
  stopLiveTick();
  releaseWakeLock();
  lastMessage = "";
  app.className = "app-shell";

  // Routage volontairement simple : chaque écran est rendu depuis le hash.
  const route = location.hash || "#home";
  const parts = route.replace("#", "").split("/");
  const screen = parts[0];
  const id = parts[1];
  const mode = parts[2];

  if (screen === "course" && id === "new") {
    renderCourseForm();
  } else if (screen === "course" && id) {
    renderCourseForm(id);
  } else if (screen === "splits" && id) {
    renderSplits(id);
  } else if (screen === "summary" && id) {
    renderSummary(id);
  } else if (screen === "live") {
    renderLive();
  } else if (screen === "resume") {
    renderResumeRun();
  } else if (screen === "report") {
    renderReport(id);
  } else {
    renderHome(mode);
  }

  app.focus({ preventScroll: true });
}

function setTitle(title) {
  screenTitle.textContent = title;
  document.title = `${title} - Race Split Assistant`;
}

function renderHome() {
  setTitle("Accueil");

  const cards = courses.length
    ? courses.map(renderCourseCard).join("")
    : `<div class="empty">Vous n’avez pas encore créé de course.</div>`;

  app.innerHTML = `
    <section class="stack">
      <div class="home-hero">
        <h2>Race Split Assistant</h2>
        <p>Prépare tes splits. Suis ton chrono. Gère ta course.</p>
        <div class="actions two">
          <button class="button" type="button" data-route="#course/new">Créer une course</button>
          <label class="button secondary" for="import-json">Importer</label>
        </div>
        <input class="sr-only" id="import-json" type="file" accept="application/json">
      </div>
      <div class="card how-card">
        <h2>Comment ça marche ?</h2>
        <ol class="how-list">
          <li>Crée une course.</li>
          <li>Ajoute tes checkpoints.</li>
          <li>Lance le mode live.</li>
          <li>Appuie sur “Point passé” à chaque ravito ou repère.</li>
          <li>L’app calcule ton avance, ton retard, le temps restant et la distance restante.</li>
        </ol>
      </div>
      <div class="toolbar">
        <button class="button secondary" type="button" data-action="export">Exporter JSON</button>
      </div>
      ${activeRun && activeRun.status !== "finished" ? `
        <div class="notice">
          Une course est en cours. Le chrono est sauvegardé localement.
          <button class="button success" type="button" data-route="#live">Reprendre le live</button>
        </div>
      ` : ""}
      <div class="grid">${cards}</div>
    </section>
  `;

  app.querySelector("[data-action='export']").addEventListener("click", exportCourses);
  app.querySelector("#import-json").addEventListener("change", importCourses);

  app.querySelectorAll("[data-action='delete-course']").forEach((button) => {
    button.addEventListener("click", () => confirmDeleteCourse(button.dataset.id));
  });

  app.querySelectorAll("[data-action='duplicate-course']").forEach((button) => {
    button.addEventListener("click", () => duplicateCourse(button.dataset.id));
  });

  app.querySelectorAll("[data-action='view-course']").forEach((button) => {
    button.addEventListener("click", () => {
      location.hash = `#summary/${button.dataset.id}`;
    });
  });

  app.querySelectorAll("[data-action='quick-start']").forEach((button) => {
    button.addEventListener("click", () => startRun(button.dataset.id));
  });
}

function renderResumeRun() {
  const course = activeRun ? findCourse(activeRun.courseId) : null;
  if (!activeRun || !course || activeRun.status === "finished") {
    return navigateHome();
  }

  setTitle("Course en cours");
  course.checkpoints.sort(sortByDistance);
  const current = course.checkpoints[activeRun.currentIndex] || null;

  app.innerHTML = `
    <section class="stack">
      <div class="card resume-card">
        <h2>Course en cours détectée</h2>
        <div class="meta-grid">
          <div class="metric"><span>Course</span><strong>${escapeHtml(course.name)}</strong></div>
          <div class="metric"><span>Temps écoulé</span><strong>${formatTime(getElapsedSeconds(activeRun))}</strong></div>
          <div class="metric"><span>Checkpoint à valider</span><strong>${current ? escapeHtml(current.name) : "Arrivée passée"}</strong></div>
          <div class="metric"><span>Déjà validés</span><strong>${activeRun.history.length}</strong></div>
          <div class="metric"><span>Distance estimée</span><strong>${formatKm(activeRun.currentDistanceKm || 0)}</strong></div>
        </div>
        <p class="muted-text">La course active est sauvegardée sur ce téléphone.</p>
      </div>
      <div class="actions two">
        <button class="button success" type="button" data-route="#live">Reprendre la course</button>
        <button class="button danger" type="button" data-action="abandon-run">Abandonner la course</button>
      </div>
    </section>
  `;

  app.querySelector("[data-action='abandon-run']").addEventListener("click", () => {
    confirmDialog("Abandonner la course active ? Les courses sauvegardées ne seront pas supprimées.", () => {
      activeRun = null;
      saveActiveRun();
      location.hash = "#home";
    });
  });
}

function renderCourseCard(course) {
  const status = getCourseRunStatus(course.id);

  return `
    <article class="card course-card">
      <div class="card-header">
        <div>
          <h2>${escapeHtml(course.name)}</h2>
          <div class="tag-row">
            <span class="tag">${escapeHtml(course.type)}</span>
            <span class="tag gray">${course.checkpoints.length} checkpoints</span>
            ${status ? `<span class="tag ${status.className}">${status.label}</span>` : ""}
          </div>
        </div>
      </div>
      <div class="meta-grid">
        <div class="metric"><span>Distance</span><strong>${formatKm(course.distanceKm)}</strong></div>
        <div class="metric"><span>Objectif</span><strong>${formatTime(course.targetSeconds)}</strong></div>
      </div>
      <div class="actions two course-actions">
        <button class="button secondary" type="button" data-action="view-course" data-id="${course.id}">Voir</button>
        <button class="button" type="button" data-action="quick-start" data-id="${course.id}">Lancer</button>
      </div>
      <div class="actions two course-actions">
        <button class="button ghost" type="button" data-action="duplicate-course" data-id="${course.id}">Dupliquer</button>
        <button class="button danger" type="button" data-action="delete-course" data-id="${course.id}">Supprimer</button>
      </div>
    </article>
  `;
}

function getCourseRunStatus(courseId) {
  if (!activeRun || activeRun.courseId !== courseId) return null;
  if (activeRun.status === "paused") return { label: "En pause", className: "status-warning" };
  if (activeRun.status === "finished") return { label: "Terminé", className: "status-good" };
  return { label: "En cours", className: "status-good" };
}

function renderCourseForm(courseId = null) {
  const editing = Boolean(courseId);
  const course = editing ? findCourse(courseId) : createBlankCourse();

  if (!course) {
    return navigateHome();
  }

  setTitle(editing ? "Course" : "Nouvelle course");

  app.innerHTML = `
    ${editing ? renderScreenNav(course.id) : ""}
    <section class="card">
      <form class="form" id="course-form" novalidate>
        <div id="form-errors"></div>
        <div class="field">
          <label for="name">Nom de la course</label>
          <input id="name" name="name" required value="${escapeAttr(course.name)}">
        </div>
        <div class="grid two">
          <div class="field">
            <label for="distanceKm">Distance totale en km</label>
            <input id="distanceKm" name="distanceKm" inputmode="decimal" required value="${escapeAttr(course.distanceKm || "")}">
            <small>Exemple : 19.7</small>
          </div>
          <div class="field">
            <label for="targetTime">Objectif chrono</label>
            <input id="targetTime" name="targetTime" placeholder="HH:MM:SS ou MM:SS" required value="${formatTimeInput(course.targetSeconds)}">
            <small>Exemple : 02:00:00</small>
          </div>
        </div>
        <div class="field">
          <label for="type">Type de course</label>
          <select id="type" name="type">${options(courseTypes, course.type)}</select>
        </div>
        <div class="field">
          <label for="notes">Notes personnelles</label>
          <textarea id="notes" name="notes">${escapeHtml(course.notes || "")}</textarea>
        </div>
        <div class="actions two">
          <button class="button" type="submit">Enregistrer</button>
          <button class="button secondary" type="button" data-route="#home">Annuler</button>
        </div>
      </form>
    </section>
  `;

  app.querySelector("#course-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveCourseFromForm(courseId);
  });
}

function saveCourseFromForm(courseId) {
  const form = app.querySelector("#course-form");
  const formData = new FormData(form);
  const name = String(formData.get("name") || "").trim();
  const distanceKm = parseDecimal(formData.get("distanceKm"));
  const targetSeconds = parseTimeInput(formData.get("targetTime"));
  const type = String(formData.get("type") || "Autre");
  const notes = String(formData.get("notes") || "").trim();

  const errors = [];
  if (!name) errors.push("Le nom est obligatoire.");
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) errors.push("La distance doit être supérieure à 0.");
  if (targetSeconds === null || targetSeconds <= 0) errors.push("L’objectif chrono doit être valide.");

  if (errors.length) {
    showErrors(errors);
    return;
  }

  const now = new Date().toISOString();
  let course = courseId ? findCourse(courseId) : null;

  if (!course) {
    course = createBlankCourse();
    course.id = uid();
    course.createdAt = now;
    course.checkpoints = [];
    courses.push(course);
  }

  course.name = name;
  course.distanceKm = distanceKm;
  course.targetSeconds = targetSeconds;
  course.type = type;
  course.notes = notes;
  course.updatedAt = now;

  saveCourses();
  location.hash = `#splits/${course.id}`;
}

function renderSplits(courseId) {
  const course = findCourse(courseId);
  if (!course) return navigateHome();

  setTitle("Splits");
  course.checkpoints.sort(sortByDistance);
  const metrics = calculateCourseMetrics(course);
  const alert = getLastCheckpointAlert(course);
  const importantZones = course.checkpoints.filter((checkpoint) => ["Ravito", "Zone difficile", "Finish"].includes(checkpoint.zoneType));

  app.innerHTML = `
    ${renderScreenNav(course.id)}
    <section class="stack">
      <div class="card">
        <h2>${escapeHtml(course.name)}</h2>
        <div class="meta-grid">
          <div class="metric"><span>Distance totale</span><strong>${formatKm(course.distanceKm)}</strong></div>
          <div class="metric"><span>Objectif</span><strong>${formatTime(course.targetSeconds)}</strong></div>
          <div class="metric"><span>Allure moyenne</span><strong>${formatPace(metrics.globalPace)}</strong></div>
          <div class="metric"><span>Ravitos prévus</span><strong>${formatShortDuration(metrics.totalAidSeconds)}</strong></div>
          <div class="metric"><span>Checkpoints</span><strong>${course.checkpoints.length}</strong></div>
        </div>
        <button class="button add-checkpoint-button" type="button" data-action="focus-checkpoint-form">Ajouter un checkpoint</button>
      </div>
      ${alert ? `<div class="notice warning">${escapeHtml(alert)}</div>` : ""}
      <div class="card checkpoint-editor is-hidden" id="checkpoint-editor"></div>
      <div class="split-list">
        ${course.checkpoints.length ? course.checkpoints.map((checkpoint, index) => renderSplitCard(course, checkpoint, index)).join("") : `<div class="empty">Aucun checkpoint pour cette course.</div>`}
      </div>
      <div class="actions two">
        <button class="button secondary" type="button" data-route="#course/${course.id}/edit">Modifier la course</button>
        <button class="button" type="button" data-route="#summary/${course.id}">Voir le résumé</button>
      </div>
    </section>
  `;

  app.querySelector("[data-action='focus-checkpoint-form']").addEventListener("click", () => {
    showCheckpointForm(course);
  });

  app.querySelectorAll("[data-action='edit-checkpoint']").forEach((button) => {
    button.addEventListener("click", () => showCheckpointForm(course, button.dataset.id));
  });

  app.querySelectorAll("[data-action='delete-checkpoint']").forEach((button) => {
    button.addEventListener("click", () => confirmDeleteCheckpoint(course.id, button.dataset.id));
  });

}

function renderCheckpointForm(course, checkpoint = null) {
  const item = checkpoint || {
    id: "",
    name: "",
    distanceKm: "",
    targetSeconds: null,
    zoneType: "Plat",
    strategy: "Course continue",
    advice: "",
    aidSeconds: ""
  };

  return `
    <form class="form" id="checkpoint-form" novalidate>
      <input type="hidden" name="checkpointId" id="checkpointId" value="${escapeAttr(item.id)}">
      <div id="form-errors"></div>
      <div class="grid two">
        <div class="field">
          <label for="checkpointName">Nom du checkpoint</label>
          <input id="checkpointName" name="checkpointName" required value="${escapeAttr(item.name)}">
        </div>
        <div class="field">
          <label for="checkpointDistance">Distance cumulée</label>
          <input id="checkpointDistance" name="checkpointDistance" inputmode="decimal" required value="${escapeAttr(item.distanceKm)}">
          <small>Distance depuis le départ.</small>
        </div>
      </div>
      <div class="grid two">
        <div class="field">
          <label for="checkpointTime">Temps cible cumulé</label>
          <input id="checkpointTime" name="checkpointTime" placeholder="HH:MM:SS" required value="${formatTimeInput(item.targetSeconds)}">
          <small>Chrono prévu à ce checkpoint.</small>
        </div>
        <div class="field">
          <label for="zoneType">Type de zone</label>
          <select id="zoneType" name="zoneType">${options(zoneTypes, item.zoneType)}</select>
        </div>
      </div>
      <div class="field">
        <label for="strategy">Stratégie</label>
        <select id="strategy" name="strategy">${options(strategies, item.strategy)}</select>
      </div>
      <div class="field" id="aid-field">
        <label for="aidSeconds">Temps ravito max en secondes</label>
        <input id="aidSeconds" name="aidSeconds" inputmode="numeric" value="${escapeAttr(item.aidSeconds || "")}">
      </div>
      <div class="field">
        <label for="advice">Conseil personnel</label>
        <textarea id="advice" name="advice">${escapeHtml(item.advice || "")}</textarea>
      </div>
      <div class="actions two">
        <button class="button" type="submit">Enregistrer le checkpoint</button>
        <button class="button secondary" type="button" data-action="clear-checkpoint">Annuler</button>
      </div>
    </form>
  `;
}

function toggleAidField() {
  const zone = app.querySelector("#zoneType");
  const field = app.querySelector("#aid-field");
  const input = app.querySelector("#aidSeconds");
  if (!zone || !field) return;
  const hasValue = input && Number(input.value) > 0;
  field.style.display = zone.value === "Ravito" || hasValue ? "grid" : "none";
}

function saveCheckpointFromForm(courseId) {
  const course = findCourse(courseId);
  const form = app.querySelector("#checkpoint-form");
  const formData = new FormData(form);
  const checkpointId = String(formData.get("checkpointId") || "");
  const name = String(formData.get("checkpointName") || "").trim();
  const distanceKm = parseDecimal(formData.get("checkpointDistance"));
  const targetSeconds = parseTimeInput(formData.get("checkpointTime"));
  const zoneType = String(formData.get("zoneType") || "Autre");
  const strategy = String(formData.get("strategy") || "Libre");
  const advice = String(formData.get("advice") || "").trim();
  const aidSeconds = Math.max(0, Math.round(parseDecimal(formData.get("aidSeconds")) || 0));

  const errors = [];
  if (!name) errors.push("Le nom du checkpoint est obligatoire.");
  if (!Number.isFinite(distanceKm) || distanceKm < 0) errors.push("La distance doit être valide.");
  if (targetSeconds === null) errors.push("Le temps cible doit être valide.");
  if (distanceKm > course.distanceKm + 0.001) errors.push("La distance ne doit pas dépasser la distance totale.");

  const candidate = {
    id: checkpointId || uid(),
    name,
    distanceKm,
    targetSeconds,
    zoneType,
    strategy,
    advice,
    aidSeconds
  };

  const otherCheckpoints = course.checkpoints.filter((item) => item.id !== checkpointId);
  const ordered = [...otherCheckpoints, candidate].sort(sortByDistance);
  // Les splits sont calculés sur l’ordre de distance : il doit rester strict.
  const orderErrors = validateCheckpointOrder(ordered);
  errors.push(...orderErrors);

  if (errors.length) {
    showErrors(errors);
    return;
  }

  const index = course.checkpoints.findIndex((item) => item.id === checkpointId);
  if (index >= 0) {
    course.checkpoints[index] = candidate;
  } else {
    course.checkpoints.push(candidate);
  }

  course.checkpoints.sort(sortByDistance);
  course.updatedAt = new Date().toISOString();
  saveCourses();
  renderSplits(courseId);
}

function showCheckpointForm(course, checkpointId = null) {
  const checkpoint = checkpointId ? course.checkpoints.find((item) => item.id === checkpointId) : null;
  if (checkpointId && !checkpoint) return;

  const card = app.querySelector("#checkpoint-editor");
  if (!card) return;

  card.classList.remove("is-hidden");
  card.innerHTML = `<h2>${checkpoint ? "Modifier un checkpoint" : "Ajouter un checkpoint"}</h2>${renderCheckpointForm(course, checkpoint)}`;
  card.querySelector("#checkpoint-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveCheckpointFromForm(course.id);
  });
  card.querySelector("[data-action='clear-checkpoint']").addEventListener("click", () => hideCheckpointForm(course.id));
  card.querySelector("#zoneType").addEventListener("change", toggleAidField);
  toggleAidField();
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  card.querySelector("#checkpointName").focus();
}

function hideCheckpointForm(courseId) {
  const card = app.querySelector("#checkpoint-editor");
  if (!card) return renderSplits(courseId);

  card.classList.add("is-hidden");
  card.innerHTML = "";
}

function renderSplitCard(course, checkpoint, index) {
  const previous = course.checkpoints[index - 1] || null;
  const split = calculateSplit(previous, checkpoint);
  const zoneClass = `zone-${slug(checkpoint.zoneType)}`;

  return `
    <article class="card split-card ${zoneClass}">
      <div class="card-header">
        <div>
          <h3>${escapeHtml(checkpoint.name)}</h3>
          <div class="tag-row">
            <span class="tag">${formatKm(checkpoint.distanceKm)}</span>
            <span class="tag">${formatTime(checkpoint.targetSeconds)}</span>
            <span class="tag ${zoneTagClass(checkpoint.zoneType)}">${escapeHtml(checkpoint.zoneType)}</span>
          </div>
        </div>
      </div>
      <div class="meta-grid">
        <div class="metric"><span>Distance cumulée</span><strong>${formatKm(checkpoint.distanceKm)}</strong></div>
        <div class="metric"><span>Temps cible</span><strong>${formatTime(checkpoint.targetSeconds)}</strong></div>
        <div class="metric"><span>Distance du split</span><strong>${formatKm(split.distanceKm)}</strong></div>
        <div class="metric"><span>Temps split</span><strong>${formatTime(split.seconds)}</strong></div>
        <div class="metric"><span>Allure split</span><strong>${formatPace(split.pace)}</strong></div>
        <div class="metric"><span>Stratégie</span><strong>${escapeHtml(checkpoint.strategy)}</strong></div>
      </div>
      ${checkpoint.advice ? `<p>${escapeHtml(checkpoint.advice)}</p>` : ""}
      ${checkpoint.aidSeconds ? `<p class="tag yellow">Ravito max ${checkpoint.aidSeconds} s</p>` : ""}
      <div class="actions two">
        <button class="button secondary" type="button" data-action="edit-checkpoint" data-id="${checkpoint.id}">Modifier</button>
        <button class="button danger" type="button" data-action="delete-checkpoint" data-id="${checkpoint.id}">Supprimer</button>
      </div>
    </article>
  `;
}

function renderSummary(courseId) {
  const course = findCourse(courseId);
  if (!course) return navigateHome();

  setTitle("Résumé");
  course.checkpoints.sort(sortByDistance);
  const metrics = calculateCourseMetrics(course);
  const alert = getLastCheckpointAlert(course);
  const importantZones = course.checkpoints.filter((checkpoint) => ["Ravito", "Zone difficile", "Finish"].includes(checkpoint.zoneType));

  app.innerHTML = `
    ${renderScreenNav(course.id)}
    <section class="stack">
      <div class="card">
        <h2>${escapeHtml(course.name)}</h2>
        <div class="meta-grid">
          <div class="metric"><span>Distance</span><strong>${formatKm(course.distanceKm)}</strong></div>
          <div class="metric"><span>Objectif</span><strong>${formatTime(course.targetSeconds)}</strong></div>
          <div class="metric"><span>Allure globale</span><strong>${formatPace(metrics.globalPace)}</strong></div>
          <div class="metric"><span>Checkpoints</span><strong>${course.checkpoints.length}</strong></div>
          <div class="metric"><span>Ravitos prévus</span><strong>${formatShortDuration(metrics.totalAidSeconds)}</strong></div>
          <div class="metric"><span>Type</span><strong>${escapeHtml(course.type)}</strong></div>
        </div>
        ${course.notes ? `<p>${escapeHtml(course.notes)}</p>` : ""}
      </div>
      ${alert ? `<div class="notice warning">${escapeHtml(alert)}</div>` : ""}
      <div class="card">
        <h2>Zones importantes</h2>
        <div class="tag-row">
          ${importantZones.length ? importantZones.map((checkpoint) => `<span class="tag ${zoneTagClass(checkpoint.zoneType)}">${escapeHtml(checkpoint.name)} · ${escapeHtml(checkpoint.zoneType)}</span>`).join("") : `<span class="tag gray">Aucune zone particulière</span>`}
        </div>
      </div>
      <div class="split-list">
        ${course.checkpoints.map((checkpoint, index) => renderSummaryCheckpoint(course, checkpoint, index)).join("")}
      </div>
      <div class="actions two">
        <button class="button secondary" type="button" data-route="#splits/${course.id}">Modifier les splits</button>
        <button class="button success primary-live-button" type="button" data-action="start-run">Lancer le mode course</button>
      </div>
    </section>
  `;

  app.querySelector("[data-action='start-run']").addEventListener("click", () => startRun(course.id));
}

function renderSummaryCheckpoint(course, checkpoint, index) {
  const split = calculateSplit(course.checkpoints[index - 1] || null, checkpoint);
  return `
    <article class="card split-card zone-${slug(checkpoint.zoneType)}">
      <h3>${escapeHtml(checkpoint.name)}</h3>
      <div class="tag-row">
        <span class="tag">${formatKm(checkpoint.distanceKm)}</span>
        <span class="tag">${formatTime(checkpoint.targetSeconds)}</span>
        <span class="tag ${zoneTagClass(checkpoint.zoneType)}">${escapeHtml(checkpoint.zoneType)}</span>
        <span class="tag gray">${formatPace(split.pace)}</span>
      </div>
      ${checkpoint.advice ? `<p>${escapeHtml(checkpoint.advice)}</p>` : ""}
    </article>
  `;
}

function startRun(courseId) {
  const course = findCourse(courseId);
  if (!course || course.checkpoints.length === 0) {
    showModal("Ajoutez au moins un checkpoint avant de lancer la course.");
    return;
  }

  course.checkpoints.sort(sortByDistance);
  const now = Date.now();
  const first = course.checkpoints[0];
  const hasAutomaticStart = isAutomaticStartCheckpoint(first);

  activeRun = {
    id: uid(),
    courseId,
    status: "running",
    startTimestamp: now,
    pausedDuration: 0,
    pauseStartedAt: null,
    currentIndex: hasAutomaticStart ? 1 : 0,
    currentDistanceKm: hasAutomaticStart ? first.distanceKm : 0,
    lastCheckpointIndex: hasAutomaticStart ? 0 : -1,
    history: hasAutomaticStart ? [createHistoryEntry(first, 0, now)] : [],
    finishedAt: null,
    finalElapsedSeconds: null
  };

  saveActiveRun();
  location.hash = "#live";
}

function isAutomaticStartCheckpoint(checkpoint) {
  return Boolean(
    checkpoint &&
    Math.abs(Number(checkpoint.distanceKm) || 0) < 0.001 &&
    Number(checkpoint.targetSeconds) === 0
  );
}

function createHistoryEntry(checkpoint, actualSeconds, timestamp = Date.now()) {
  const diffSeconds = actualSeconds - checkpoint.targetSeconds;
  const status = getStatus(diffSeconds);

  return {
    checkpointId: checkpoint.id,
    name: checkpoint.name,
    distanceKm: checkpoint.distanceKm,
    targetSeconds: checkpoint.targetSeconds,
    actualSeconds,
    diffSeconds,
    statusClass: status.className,
    passedAt: new Date(timestamp).toISOString()
  };
}

function renderLive() {
  const course = activeRun ? findCourse(activeRun.courseId) : null;
  if (!activeRun || !course) {
    setTitle("Live");
    app.innerHTML = `
      <section class="stack">
        <div class="empty">Aucune course active.</div>
        <button class="button" type="button" data-route="#home">Retour accueil</button>
      </section>
    `;
    return;
  }

  setTitle("Live");
  course.checkpoints.sort(sortByDistance);
  app.innerHTML = `
    <section class="live-panel">
      <div id="segment-mood" class="segment-mood mood-neutral">
        <span>Segment en cours</span>
        <strong>Reste propre et régulier.</strong>
      </div>
      <div class="timer">
        <span class="timer-label">${escapeHtml(course.name)}</span>
        <span class="timer-value" id="timer-value">00:00:00</span>
      </div>
      <div id="live-status" class="status">Dans le rythme</div>
      <div id="live-stats" class="live-stats"></div>
      <div id="live-details" class="live-details"></div>
      <button class="button success primary-live-button" type="button" data-action="pass-checkpoint">Point passé</button>
      <details class="live-extra">
        <summary>Infos de rythme</summary>
        <div id="live-next"></div>
      </details>
      <details class="live-extra">
        <summary>Distance estimée</summary>
        <p id="manual-distance-value" class="muted-text">0 km</p>
        <div class="actions four distance-actions">
          <button class="button secondary" type="button" data-action="adjust-distance" data-delta="0.1">+0.1 km</button>
          <button class="button secondary" type="button" data-action="adjust-distance" data-delta="0.5">+0.5 km</button>
          <button class="button secondary" type="button" data-action="edit-distance">Modifier</button>
          <button class="button secondary" type="button" data-action="snap-distance">Recaler</button>
        </div>
      </details>
      <div id="last-passage"></div>
      <div class="actions two secondary-live-actions">
        <button class="button secondary" type="button" data-action="toggle-pause">Pause</button>
        <button class="button danger secondary-danger" type="button" data-action="reset-run">Reset</button>
      </div>
      <p class="wake-note">Gardez l’écran actif si votre téléphone ne prend pas en charge le maintien d’écran.</p>
      <details class="card compact-history">
        <summary>Historique</summary>
        <div id="live-history" class="history-list"></div>
      </details>
      <button class="button secondary menu-exit-button" type="button" data-action="leave-live-menu">Revenir au menu</button>
    </section>
  `;

  app.querySelector("[data-action='pass-checkpoint']").addEventListener("click", passCheckpoint);
  app.querySelector("[data-action='toggle-pause']").addEventListener("click", togglePause);
  app.querySelector("[data-action='reset-run']").addEventListener("click", confirmResetRun);
  app.querySelector("[data-action='leave-live-menu']").addEventListener("click", confirmLeaveLiveToMenu);
  app.querySelectorAll("[data-action='adjust-distance']").forEach((button) => {
    button.addEventListener("click", () => adjustManualDistance(Number(button.dataset.delta)));
  });
  app.querySelector("[data-action='edit-distance']").addEventListener("click", editManualDistance);
  app.querySelector("[data-action='snap-distance']").addEventListener("click", snapDistanceToLastCheckpoint);

  updateLiveView();
  liveTick = window.setInterval(updateLiveView, 500);
  requestWakeLock();
}

function updateLiveView() {
  if (!activeRun) return;
  const course = findCourse(activeRun.courseId);
  if (!course) return;

  const elapsedSeconds = getElapsedSeconds(activeRun);
  const current = course.checkpoints[activeRun.currentIndex] || null;
  const next = course.checkpoints[activeRun.currentIndex + 1] || null;
  const liveMetrics = calculateLiveMetrics(course, activeRun, elapsedSeconds);
  const timer = app.querySelector("#timer-value");
  const segmentMood = app.querySelector("#segment-mood");
  const status = app.querySelector("#live-status");
  const liveStats = app.querySelector("#live-stats");
  const details = app.querySelector("#live-details");
  const nextContainer = app.querySelector("#live-next");
  const history = app.querySelector("#live-history");
  const lastPassage = app.querySelector("#last-passage");
  const manualDistanceValue = app.querySelector("#manual-distance-value");
  const pauseButton = app.querySelector("[data-action='toggle-pause']");
  const passButton = app.querySelector("[data-action='pass-checkpoint']");

  if (!timer || !segmentMood || !status || !liveStats || !details || !nextContainer || !history || !lastPassage || !manualDistanceValue) return;

  timer.textContent = formatTime(elapsedSeconds);
  activeRun.currentDistanceKm = liveMetrics.currentDistanceKm;
  manualDistanceValue.textContent = `${formatKm(liveMetrics.currentDistanceKm)} depuis le départ`;
  pauseButton.textContent = activeRun.status === "paused" ? "Reprendre" : "Pause";
  passButton.disabled = !current || activeRun.status === "paused";

  const target = current ? current.targetSeconds : course.targetSeconds;
  const diff = elapsedSeconds - target;
  const liveStatus = getStatus(diff);
  status.className = `status ${liveStatus.className}`;
  status.textContent = activeRun.status === "paused" ? "Pause active" : liveStatus.label;
  const mood = getSegmentMood(current);
  app.className = `app-shell live-${mood.className}`;
  segmentMood.className = `segment-mood mood-${mood.className}`;
  segmentMood.innerHTML = `
    <span>${escapeHtml(mood.label)}</span>
    <strong>${escapeHtml(mood.message)}</strong>
  `;

  liveStats.innerHTML = `
    <div class="card live-stat-card live-main-card">
      <span>Checkpoint à valider</span>
      <strong>${current ? escapeHtml(current.name) : "Arrivée passée"}</strong>
      <small>${current ? `${formatKm(current.distanceKm)} · cible ${formatTime(current.targetSeconds)}` : "Tous les points sont validés"}</small>
    </div>
    <div class="card live-stat-card">
      <span>Distance restante</span>
      <strong>${formatKm(liveMetrics.distanceRemaining)}</strong>
    </div>
    <div class="card live-stat-card ${liveMetrics.targetRemaining < -180 ? "status-danger" : liveMetrics.targetRemaining < 0 ? "status-warning" : ""}">
      <span>Temps objectif restant</span>
      <strong>${formatRemainingTime(liveMetrics.targetRemaining)}</strong>
    </div>
  `;

  details.innerHTML = `
    <div class="card live-target-card">
      ${current ? `
        <div class="segment-advice">
          <span>Conseil du segment en cours</span>
          <strong>${escapeHtml(current.advice || current.strategy || "Reste régulier.")}</strong>
        </div>
      ` : `<p>Tous les checkpoints sont passés.</p>`}
    </div>
  `;

  nextContainer.innerHTML = `
    <div class="card live-next-card">
      <h2>Infos de rythme</h2>
      ${current ? `
        <div class="meta-grid">
          <div class="metric"><span>Prochain point</span><strong>${escapeHtml(current.name)} dans ${formatKm(liveMetrics.checkpointDistance)}</strong></div>
          <div class="metric"><span>Temps jusqu’au point</span><strong>${formatRemainingTime(liveMetrics.checkpointRemaining)}</strong></div>
          <div class="metric"><span>Allure jusqu’au point</span><strong>${formatPace(liveMetrics.paceToCheckpoint)}</strong></div>
          <div class="metric"><span>Allure restante</span><strong>${formatPace(liveMetrics.paceRemaining)}</strong></div>
        </div>
        ${next ? `<p class="muted-text">Après celui-ci : ${escapeHtml(next.name)} à ${formatKm(next.distanceKm)}.</p>` : `<p class="muted-text">Fin de course après ce point.</p>`}
      ` : `<p>Fin de course après ce point.</p>`}
    </div>
  `;

  const last = activeRun.history[activeRun.history.length - 1];
  lastPassage.innerHTML = last ? renderLastPassage(last) : "";

  history.innerHTML = activeRun.history.length
    ? activeRun.history.slice().reverse().map(renderHistoryItem).join("")
    : `<div class="empty">Aucun passage enregistré.</div>`;
}

function passCheckpoint() {
  const course = findCourse(activeRun.courseId);
  const checkpoint = course.checkpoints[activeRun.currentIndex];
  if (!checkpoint || activeRun.status === "paused") return;

  const actualSeconds = getElapsedSeconds(activeRun);
  const next = course.checkpoints[activeRun.currentIndex + 1] || null;

  activeRun.history.push(createHistoryEntry(checkpoint, actualSeconds));

  activeRun.currentDistanceKm = checkpoint.distanceKm;
  activeRun.lastCheckpointIndex = activeRun.currentIndex;
  activeRun.currentIndex += 1;
  lastMessage = `
    <strong>${escapeHtml(checkpoint.name)}</strong><br>
    Cible ${formatTime(checkpoint.targetSeconds)} · Réel ${formatTime(actualSeconds)} · ${formatDiff(actualSeconds - checkpoint.targetSeconds)}.
    ${next && next.advice ? `<br>${escapeHtml(next.advice)}` : ""}
  `;

  if (activeRun.currentIndex >= course.checkpoints.length) {
    activeRun.finalElapsedSeconds = actualSeconds;
    activeRun.finishedAt = Date.now();
    activeRun.status = "finished";
  }

  saveActiveRun();
  updateLiveView();

  if (activeRun.finishedAt) {
    location.hash = `#report/${activeRun.id}`;
  }
}

function adjustManualDistance(deltaKm) {
  const course = activeRun ? findCourse(activeRun.courseId) : null;
  if (!activeRun || !course) return;

  activeRun.currentDistanceKm = clampManualDistance(
    course,
    (Number(activeRun.currentDistanceKm) || 0) + deltaKm
  );
  saveActiveRun();
  updateLiveView();
}

function editManualDistance() {
  const course = activeRun ? findCourse(activeRun.courseId) : null;
  if (!activeRun || !course || typeof window.prompt !== "function") return;

  const value = window.prompt("Distance estimée en km", String(activeRun.currentDistanceKm ?? 0));
  if (value === null) return;

  const parsed = parseDecimal(value);
  if (!Number.isFinite(parsed)) {
    showModal("Distance invalide.");
    return;
  }

  activeRun.currentDistanceKm = clampManualDistance(course, parsed);
  saveActiveRun();
  updateLiveView();
}

function snapDistanceToLastCheckpoint() {
  const course = activeRun ? findCourse(activeRun.courseId) : null;
  if (!activeRun || !course) return;

  activeRun.currentDistanceKm = getLastValidatedDistance(course, activeRun);
  saveActiveRun();
  updateLiveView();
}

function togglePause() {
  if (!activeRun) return;

  if (activeRun.status === "paused") {
    activeRun.pausedDuration += Date.now() - activeRun.pauseStartedAt;
    activeRun.pauseStartedAt = null;
    activeRun.status = "running";
  } else {
    activeRun.pauseStartedAt = Date.now();
    activeRun.status = "paused";
  }

  saveActiveRun();
  updateLiveView();
}

function finishRun() {
  if (!activeRun) return;

  activeRun.finalElapsedSeconds = getElapsedSeconds(activeRun);
  activeRun.finishedAt = Date.now();
  activeRun.status = "finished";
  saveActiveRun();
  location.hash = `#report/${activeRun.id}`;
}

function confirmResetRun() {
  confirmDialog("Réinitialiser la course active ? L’historique live sera effacé.", () => {
    activeRun = null;
    saveActiveRun();
    location.hash = "#home";
  });
}

function renderReport() {
  const course = activeRun ? findCourse(activeRun.courseId) : null;
  if (!activeRun || !course) {
    return navigateHome();
  }

  stopLiveTick();
  setTitle("Bilan");

  const finalSeconds = activeRun.finalElapsedSeconds ?? getElapsedSeconds(activeRun);
  const finalDiff = finalSeconds - course.targetSeconds;
  const report = calculateReport(activeRun.history);

  app.innerHTML = `
    ${renderScreenNav(course.id)}
    <section class="stack">
      <div class="card">
        <h2>${escapeHtml(course.name)}</h2>
        <div class="meta-grid">
          <div class="metric"><span>Temps final</span><strong>${formatTime(finalSeconds)}</strong></div>
          <div class="metric"><span>Objectif</span><strong>${formatTime(course.targetSeconds)}</strong></div>
          <div class="metric"><span>Écart final</span><strong>${formatDiff(finalDiff)}</strong></div>
          <div class="metric"><span>Distance totale</span><strong>${formatKm(course.distanceKm)}</strong></div>
          <div class="metric"><span>Passages</span><strong>${activeRun.history.length}</strong></div>
        </div>
      </div>
      <div class="card">
        <h2>Résumé</h2>
        <div class="meta-grid">
          <div class="metric"><span>Meilleur split</span><strong>${escapeHtml(report.bestSplit)}</strong></div>
          <div class="metric"><span>Plus gros retard</span><strong>${escapeHtml(report.biggestDelay)}</strong></div>
          <div class="metric"><span>Temps perdu</span><strong>${escapeHtml(report.hardestCheckpoint)}</strong></div>
          <div class="metric"><span>Régularité</span><strong>${escapeHtml(report.regularity)}</strong></div>
        </div>
      </div>
      <div class="history-list">
        ${activeRun.history.length ? activeRun.history.map(renderReportItem).join("") : `<div class="empty">Aucun checkpoint validé.</div>`}
      </div>
      <div class="actions two">
        <button class="button secondary" type="button" data-route="#home">Accueil</button>
        <button class="button danger" type="button" data-action="clear-report">Fermer le bilan</button>
      </div>
    </section>
  `;

  app.querySelector("[data-action='clear-report']").addEventListener("click", () => {
    activeRun = null;
    saveActiveRun();
    location.hash = "#home";
  });
}

function renderHistoryItem(item) {
  return `
    <div class="history-item">
      <strong>${escapeHtml(item.name)}</strong>
      <span class="diff ${diffClass(item.diffSeconds)}">${formatDiff(item.diffSeconds)}</span>
      <span>${formatKm(item.distanceKm)} · cible ${formatTime(item.targetSeconds)}</span>
      <span>réel ${formatTime(item.actualSeconds)}</span>
    </div>
  `;
}

function renderLastPassage(item) {
  return `
    <div class="card last-passage status-border-${item.statusClass || getStatus(item.diffSeconds).className}">
      <h2>Dernier passage</h2>
      <div class="meta-grid">
        <div class="metric"><span>Checkpoint</span><strong>${escapeHtml(item.name)}</strong></div>
        <div class="metric"><span>Réel</span><strong>${formatTime(item.actualSeconds)}</strong></div>
        <div class="metric"><span>Cible</span><strong>${formatTime(item.targetSeconds)}</strong></div>
        <div class="metric"><span>Écart</span><strong class="diff ${diffClass(item.diffSeconds)}">${formatDiff(item.diffSeconds)}</strong></div>
      </div>
    </div>
  `;
}

function renderReportItem(item) {
  return `
    <article class="card">
      <h3>${escapeHtml(item.name)}</h3>
      <div class="meta-grid">
        <div class="metric"><span>Distance</span><strong>${formatKm(item.distanceKm)}</strong></div>
        <div class="metric"><span>Cible</span><strong>${formatTime(item.targetSeconds)}</strong></div>
        <div class="metric"><span>Réel</span><strong>${formatTime(item.actualSeconds)}</strong></div>
        <div class="metric"><span>Écart</span><strong class="diff ${diffClass(item.diffSeconds)}">${formatDiff(item.diffSeconds)}</strong></div>
      </div>
    </article>
  `;
}

function renderScreenNav(courseId = null) {
  const items = [
    { label: "Accueil", route: "#home" }
  ];

  if (courseId) {
    items.push(
      { label: "Course", route: `#course/${courseId}/edit` },
      { label: "Splits", route: `#splits/${courseId}` },
      { label: "Résumé", route: `#summary/${courseId}` }
    );
  }

  if (activeRun && activeRun.status !== "finished") {
    items.push({ label: "Live", route: "#live" });
  }

  if (activeRun && activeRun.status === "finished") {
    items.push({ label: "Bilan", route: `#report/${activeRun.id}` });
  }

  return `
    <nav class="screen-nav" aria-label="Navigation de l’application">
      ${items.map((item) => `<button class="button secondary" type="button" data-route="${item.route}">${item.label}</button>`).join("")}
    </nav>
  `;
}

function duplicateCourse(courseId) {
  const original = findCourse(courseId);
  if (!original) return;

  const now = new Date().toISOString();
  const copy = structuredCloneSafe(original);
  copy.id = uid();
  copy.name = `${original.name} copie`;
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.checkpoints = copy.checkpoints.map((checkpoint) => ({ ...checkpoint, id: uid() }));
  courses.push(copy);
  saveCourses();
  renderHome();
}

function confirmDeleteCourse(courseId) {
  const course = findCourse(courseId);
  if (!course) return;

  confirmDialog(`Supprimer "${course.name}" ? Cette action est définitive.`, () => {
    courses = courses.filter((item) => item.id !== courseId);
    if (activeRun && activeRun.courseId === courseId) {
      activeRun = null;
      saveActiveRun();
    }
    saveCourses();
    renderHome();
  });
}

function confirmDeleteCheckpoint(courseId, checkpointId) {
  confirmDialog("Supprimer ce checkpoint ?", () => {
    const course = findCourse(courseId);
    if (!course) return;
    course.checkpoints = course.checkpoints.filter((item) => item.id !== checkpointId);
    course.updatedAt = new Date().toISOString();
    saveCourses();
    renderSplits(courseId);
  });
}

function exportCourses() {
  const payload = {
    app: "Race Split Assistant",
    version: 1,
    exportedAt: new Date().toISOString(),
    courses
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "race-split-assistant-export.json";
  link.click();
  URL.revokeObjectURL(url);
}

function importCourses(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const imported = Array.isArray(data) ? data : data.courses;
      if (!Array.isArray(imported)) {
        throw new Error("Format invalide");
      }

      const cleaned = imported.map(normalizeCourse).filter(Boolean);
      if (!cleaned.length) {
        throw new Error("Aucune course trouvée");
      }
      if (cleaned.some((course) => validateImportedCourse(course).length > 0)) {
        throw new Error("Course invalide");
      }

      courses = mergeCourses(courses, cleaned);
      saveCourses();
      renderHome();
    } catch (error) {
      showModal("Import impossible. Vérifiez que le fichier JSON vient bien de Race Split Assistant.");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

function calculateCourseMetrics(course) {
  return {
    globalPace: course.distanceKm > 0 ? course.targetSeconds / course.distanceKm : null,
    totalAidSeconds: course.checkpoints.reduce((sum, item) => sum + (Number(item.aidSeconds) || 0), 0)
  };
}

function calculateSplit(previous, checkpoint) {
  const startDistance = previous ? previous.distanceKm : 0;
  const startTime = previous ? previous.targetSeconds : 0;
  const distanceKm = Math.max(0, checkpoint.distanceKm - startDistance);
  const seconds = Math.max(0, checkpoint.targetSeconds - startTime);
  return {
    distanceKm,
    seconds,
    pace: distanceKm > 0 ? seconds / distanceKm : null
  };
}

function calculateLiveMetrics(course, run, elapsedSeconds) {
  const current = course.checkpoints[run.currentIndex] || null;
  const currentDistanceKm = clampManualDistance(course, run.currentDistanceKm ?? getLastValidatedDistance(course, run), run);
  const distanceRemaining = Math.max(0, course.distanceKm - currentDistanceKm);
  const targetRemaining = course.targetSeconds - elapsedSeconds;
  const checkpointDistance = current ? Math.max(0, current.distanceKm - currentDistanceKm) : 0;
  const checkpointRemaining = current ? current.targetSeconds - elapsedSeconds : targetRemaining;

  return {
    currentDistanceKm,
    distanceRemaining,
    targetRemaining,
    checkpointDistance,
    checkpointRemaining,
    paceRemaining: distanceRemaining > 0 && targetRemaining > 0 ? targetRemaining / distanceRemaining : null,
    paceToCheckpoint: checkpointDistance > 0 && checkpointRemaining > 0 ? checkpointRemaining / checkpointDistance : null
  };
}

function getSegmentMood(checkpoint) {
  if (!checkpoint) {
    return {
      className: "neutral",
      label: "Course terminée",
      message: "Respire, tu peux analyser ta course."
    };
  }

  const zone = checkpoint.zoneType;
  const strategy = checkpoint.strategy;

  if (zone === "Ravito") {
    return {
      className: "aid",
      label: "Ravito en approche",
      message: "Bois vite, repars simple."
    };
  }

  if (zone === "Zone difficile" || zone === "Montée" || strategy === "Marche rapide autorisée") {
    return {
      className: "hard",
      label: "Zone dure",
      message: "Calme, efficace, un pas après l’autre."
    };
  }

  if (zone === "Descente" || strategy === "Descente contrôlée") {
    return {
      className: "control",
      label: "Contrôle",
      message: "Relâche les épaules, protège les jambes."
    };
  }

  if (zone === "Relance" || strategy === "Relance progressive") {
    return {
      className: "push",
      label: "Relance",
      message: "Reprends du rythme sans te cramer."
    };
  }

  if (zone === "Finish" || strategy === "Finish au mental") {
    return {
      className: "finish",
      label: "Finish",
      message: "Reste engagé, va chercher la ligne."
    };
  }

  if (zone === "Départ") {
    return {
      className: "start",
      label: "Départ",
      message: "Pars calme, garde de l’énergie."
    };
  }

  return {
    className: "neutral",
    label: "Segment en cours",
    message: "Reste propre et régulier."
  };
}

function clampManualDistance(course, distanceKm, run = activeRun) {
  const lastDistance = getLastValidatedDistance(course, run);
  const safeDistance = Number.isFinite(distanceKm) ? distanceKm : lastDistance;
  return Math.min(course.distanceKm, Math.max(lastDistance, roundKm(safeDistance)));
}

function getLastValidatedDistance(course, run) {
  if (!course || !run) return 0;
  const lastHistory = run.history && run.history.length ? run.history[run.history.length - 1] : null;
  if (lastHistory && Number.isFinite(lastHistory.distanceKm)) return lastHistory.distanceKm;
  const checkpoint = course.checkpoints[run.lastCheckpointIndex] || null;
  return checkpoint ? checkpoint.distanceKm : 0;
}

function roundKm(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function calculateReport(history) {
  const realHistory = history.filter((item, index) => index > 0 || item.distanceKm > 0);

  if (!realHistory.length) {
    return {
      bestSplit: "Aucun",
      biggestDelay: "Aucun",
      hardestCheckpoint: "Aucun",
      regularity: "Non calculée"
    };
  }

  const enriched = realHistory.map((item, index) => {
    const previous = realHistory[index - 1];
    return {
      item,
      splitDelta: previous ? item.diffSeconds - previous.diffSeconds : item.diffSeconds
    };
  });

  let best = realHistory[0];
  let worst = realHistory[0];
  let hardest = enriched[0];
  const diffs = realHistory.map((item) => item.diffSeconds);

  enriched.forEach(({ item, splitDelta }) => {
    if (item.diffSeconds < best.diffSeconds) best = item;
    if (item.diffSeconds > worst.diffSeconds) worst = item;
    if (splitDelta > hardest.splitDelta) hardest = { item, splitDelta };
  });

  const average = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const variance = diffs.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / diffs.length;
  const spread = Math.round(Math.sqrt(variance));

  return {
    bestSplit: `${best.name} (${formatDiff(best.diffSeconds)})`,
    biggestDelay: `${worst.name} (${formatDiff(worst.diffSeconds)})`,
    hardestCheckpoint: `${hardest.item.name} (${formatDiff(hardest.splitDelta)})`,
    regularity: spread < 45 ? "Très régulière" : spread < 120 ? "Correcte" : "Irrégulière"
  };
}

function validateCheckpointOrder(ordered) {
  const errors = [];
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].distanceKm <= ordered[index - 1].distanceKm) {
      errors.push("Les distances doivent être strictement croissantes.");
      break;
    }
    if (ordered[index].targetSeconds <= ordered[index - 1].targetSeconds) {
      errors.push("Les temps cibles doivent être strictement croissants.");
      break;
    }
  }
  return errors;
}

function validateImportedCourse(course) {
  const errors = [];
  if (!course.name || course.distanceKm <= 0 || course.targetSeconds <= 0) {
    errors.push("Course invalide.");
  }
  if (course.checkpoints.some((item) => item.distanceKm > course.distanceKm + 0.001)) {
    errors.push("Checkpoint hors distance.");
  }
  errors.push(...validateCheckpointOrder(course.checkpoints));
  return errors;
}

function getLastCheckpointAlert(course) {
  const last = course.checkpoints[course.checkpoints.length - 1];
  if (!last) return "";
  if (Math.abs(last.distanceKm - course.distanceKm) > 0.01) {
    return "Le dernier checkpoint ne correspond pas à la distance totale de la course.";
  }
  return "";
}

function getElapsedSeconds(run) {
  // Date.now() garde un chrono cohérent même si setInterval est ralenti ou suspendu.
  if (Number.isFinite(run.finalElapsedSeconds)) return Math.max(0, Math.floor(run.finalElapsedSeconds));

  const now = run.finishedAt || Date.now();
  const startTimestamp = run.startTimestamp || run.startedAt || now;
  const pausedDuration = run.pausedDuration ?? run.pauseTotalMs ?? 0;
  const pauseStartedAt = run.pauseStartedAt || run.pausedAt || null;
  const pauseInProgress = run.status === "paused" && pauseStartedAt ? now - pauseStartedAt : 0;
  const elapsedMs = now - startTimestamp - pausedDuration - pauseInProgress;
  return Math.max(0, Math.floor(elapsedMs / 1000));
}

function getStatus(diffSeconds) {
  if (diffSeconds <= -30) return { label: "En avance", className: "status-good" };
  if (diffSeconds <= 60) return { label: "Dans le rythme", className: "status-neutral" };
  if (diffSeconds <= 180) return { label: "Retard léger", className: "status-warning" };
  return { label: "Gros retard", className: "status-danger" };
}

function diffClass(seconds) {
  if (seconds <= 60) return "good";
  if (seconds <= 180) return "warn";
  return "bad";
}

function parseTimeInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parts = raw.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+$/.test(part))) return null;

  const numbers = parts.map(Number);
  const [hours, minutes, seconds] = parts.length === 3 ? numbers : [0, numbers[0], numbers[1]];
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function parseDecimal(value) {
  const normalized = String(value || "").replace(",", ".").trim();
  return Number(normalized);
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatTimeInput(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "";
  return formatTime(seconds);
}

function formatShortDuration(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return minutes ? `${minutes} min ${secs} s` : `${secs} s`;
}

function formatKm(value) {
  return `${Number(value || 0).toLocaleString("fr-FR", { maximumFractionDigits: 3 })} km`;
}

function formatPace(secondsPerKm) {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return "N/A";
  const totalSeconds = Math.round(secondsPerKm + 0.000001);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")} /km`;
}

function formatRemainingTime(seconds) {
  const safe = Math.round(Number(seconds) || 0);
  if (safe < 0) return `Objectif dépassé de ${formatTime(Math.abs(safe))}`;
  return formatTime(safe);
}

function formatDiff(seconds) {
  const safe = Math.round(Number(seconds) || 0);
  if (Math.abs(safe) < 30) return "Dans le rythme";
  const label = formatTime(Math.abs(safe));
  return safe < 0 ? `Avance : ${label}` : `Retard : ${label}`;
}

function options(values, selected) {
  return values.map((value) => `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
}

function showErrors(errors) {
  const box = app.querySelector("#form-errors");
  if (!box) return;
  box.innerHTML = `<div class="error-box">${errors.map(escapeHtml).join("<br>")}</div>`;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

function showModal(message) {
  confirmDialog(message, null, false);
}

function confirmDialog(message, onConfirm, showCancel = true) {
  const template = document.querySelector("#confirm-template");
  const node = template.content.cloneNode(true);
  const backdrop = node.querySelector(".modal-backdrop");
  node.querySelector("#confirm-message").textContent = message;

  if (!showCancel) {
    node.querySelector("[data-confirm='cancel']").style.display = "none";
    node.querySelector("[data-confirm='ok']").textContent = "OK";
  }

  backdrop.addEventListener("click", (event) => {
    const button = event.target.closest("[data-confirm]");
    if (!button) return;
    const confirmed = button.dataset.confirm === "ok";
    backdrop.remove();
    if (confirmed && onConfirm) onConfirm();
  });

  document.body.appendChild(node);
}

function createBlankCourse() {
  return {
    id: "",
    name: "",
    distanceKm: "",
    targetSeconds: null,
    type: "Route",
    notes: "",
    checkpoints: [],
    createdAt: "",
    updatedAt: ""
  };
}

function createExampleCourse() {
  const now = new Date().toISOString();
  return {
    id: uid(),
    name: "AUT 2026 — Objectif 2h",
    distanceKm: 19.7,
    targetSeconds: 7200,
    type: "Urban Trail",
    notes: "Course sans GPS, gestion manuelle aux ravitos et checkpoints.",
    createdAt: now,
    updatedAt: now,
    checkpoints: [
      checkpoint("Départ", 0, "00:00:00", "Départ", "Course continue", "Départ calme. Ne gaspille pas d’énergie."),
      checkpoint("Ravito 1", 4.3, "00:25:15", "Ravito", "Course continue", "Eau rapide. Ne t’éternise pas.", 15),
      checkpoint("Ravito 2", 6.7, "00:40:45", "Ravito", "Marche rapide autorisée", "Bois vite. Garde du jus pour la partie difficile.", 15),
      checkpoint("Ravito 3", 10, "01:03:30", "Zone difficile", "Marche rapide autorisée", "Zone clé. Ne fais pas le héros. Marche active dans les grosses montées.", 30),
      checkpoint("Ravito 4", 12.5, "01:18:00", "Relance", "Descente contrôlée", "Relance progressive. Protège les jambes en descente.", 15),
      checkpoint("Ravito 5", 15.8, "01:37:00", "Ravito", "Relance progressive", "Dernier vrai ravito. Bois, mais reste concentré.", 30),
      checkpoint("Ravito 6", 18.5, "01:53:15", "Finish", "Finish au mental", "Une gorgée maximum. Tu repars directement.", 10),
      checkpoint("Arrivée", 19.7, "02:00:00", "Finish", "Finish au mental", "Dernier bloc. Continue jusqu’à la ligne.")
    ]
  };
}

function checkpoint(name, distanceKm, targetTime, zoneType, strategy, advice, aidSeconds = 0) {
  return {
    id: uid(),
    name,
    distanceKm,
    targetSeconds: parseTimeInput(targetTime),
    zoneType,
    strategy,
    advice,
    aidSeconds
  };
}

function normalizeCourse(course) {
  if (!course || typeof course !== "object") return null;
  const targetSeconds = Number(course.targetSeconds);
  const distanceKm = Number(course.distanceKm);
  if (!course.name || !Number.isFinite(distanceKm) || !Number.isFinite(targetSeconds)) return null;

  return {
    id: course.id || uid(),
    name: String(course.name),
    distanceKm,
    targetSeconds,
    type: course.type || "Autre",
    notes: course.notes || "",
    checkpoints: Array.isArray(course.checkpoints) ? course.checkpoints.map(normalizeCheckpoint).filter(Boolean).sort(sortByDistance) : [],
    createdAt: course.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function normalizeCheckpoint(item) {
  if (!item || typeof item !== "object") return null;
  const distanceKm = Number(item.distanceKm);
  const targetSeconds = Number(item.targetSeconds);
  if (!item.name || !Number.isFinite(distanceKm) || !Number.isFinite(targetSeconds)) return null;

  return {
    id: item.id || uid(),
    name: String(item.name),
    distanceKm,
    targetSeconds,
    zoneType: zoneTypes.includes(item.zoneType) ? item.zoneType : "Autre",
    strategy: strategies.includes(item.strategy) ? item.strategy : "Libre",
    advice: item.advice || "",
    aidSeconds: Math.max(0, Number(item.aidSeconds) || 0)
  };
}

function mergeCourses(existing, imported) {
  const ids = new Set(existing.map((course) => course.id));
  const prepared = imported.map((course) => {
    if (ids.has(course.id)) {
      course.id = uid();
      course.name = `${course.name} import`;
    }
    return course;
  });
  return [...existing, ...prepared];
}

function loadCourses() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeCourse).filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function saveCourses() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(courses));
}

function loadActiveRun() {
  try {
    return normalizeActiveRun(JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null"));
  } catch (error) {
    return null;
  }
}

function saveActiveRun() {
  if (activeRun) {
    activeRun = normalizeActiveRun(activeRun);
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeRun));
  } else {
    localStorage.removeItem(ACTIVE_KEY);
  }
}

function normalizeActiveRun(run) {
  if (!run || typeof run !== "object" || !run.courseId) return null;

  const pauseStartedAt = run.pauseStartedAt ?? run.pausedAt ?? null;
  const status = run.status || (run.finishedAt ? "finished" : pauseStartedAt ? "paused" : "running");
  const history = Array.isArray(run.history) ? run.history : [];
  const lastHistory = history.length ? history[history.length - 1] : null;

  return {
    id: run.id || uid(),
    courseId: run.courseId,
    status,
    startTimestamp: run.startTimestamp || run.startedAt || Date.now(),
    pausedDuration: Number(run.pausedDuration ?? run.pauseTotalMs ?? 0),
    pauseStartedAt: status === "paused" ? pauseStartedAt : null,
    currentIndex: Number(run.currentIndex) || 0,
    currentDistanceKm: Number.isFinite(run.currentDistanceKm) ? run.currentDistanceKm : Number(lastHistory?.distanceKm) || 0,
    lastCheckpointIndex: Number.isFinite(run.lastCheckpointIndex) ? run.lastCheckpointIndex : -1,
    history,
    finishedAt: run.finishedAt || null,
    finalElapsedSeconds: Number.isFinite(run.finalElapsedSeconds) ? run.finalElapsedSeconds : null
  };
}

function findCourse(courseId) {
  return courses.find((course) => course.id === courseId);
}

function sortByDistance(a, b) {
  if (a.distanceKm === b.distanceKm) return a.targetSeconds - b.targetSeconds;
  return a.distanceKm - b.distanceKm;
}

function zoneTagClass(zoneType) {
  if (zoneType === "Ravito") return "status-aid";
  if (zoneType === "Zone difficile") return "status-warning";
  if (zoneType === "Finish") return "status-good";
  return "gray";
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function uid() {
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function navigateHome() {
  location.hash = "#home";
}

function stopLiveTick() {
  if (liveTick) {
    window.clearInterval(liveTick);
    liveTick = null;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
