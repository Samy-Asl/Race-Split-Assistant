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
let deferredInstallPrompt = null;
let serviceWorkerRegistration = null;
let waitingServiceWorker = null;
let reloadingForUpdate = false;
let routeEditorDirty = false;

const app = document.querySelector("#app");
const screenTitle = document.querySelector("#screen-title");

document.addEventListener("DOMContentLoaded", init);
window.addEventListener("hashchange", renderRoute);
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if ((location.hash || "#home") === "#home") renderHome();
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  if ((location.hash || "#home") === "#home") renderHome();
});
window.addEventListener("beforeunload", (event) => {
  if (!routeEditorDirty) return;
  event.preventDefault();
  event.returnValue = "";
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && location.hash === "#live") {
    requestWakeLock();
  }
});

function init() {
  courses = loadCourses();
  activeRun = loadActiveRun();

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
      if (shouldConfirmRouteLeave(routeButton.dataset.route)) {
        confirmDialog("Quitter sans sauvegarder le parcours ?", () => {
          routeEditorDirty = false;
          location.hash = routeButton.dataset.route;
        });
        return;
      }
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

function shouldConfirmRouteLeave(nextRoute) {
  return routeEditorDirty && location.hash.startsWith("#route/") && nextRoute !== location.hash;
}

function confirmLeaveLiveToMenu() {
  confirmDialog("Revenir au menu ? La course restera sauvegardée et pourra être reprise.", () => {
    location.hash = "#home";
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").then((registration) => {
      serviceWorkerRegistration = registration;
      if (registration.waiting) {
        showUpdateNotice(registration.waiting);
      }

      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateNotice(newWorker);
          }
        });
      });
    }).catch(() => {});

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadingForUpdate) return;
      reloadingForUpdate = true;
      window.location.reload();
    });
  }
}

function showUpdateNotice(worker) {
  waitingServiceWorker = worker;
  const existing = document.querySelector("#update-notice");
  if (existing) return;

  const notice = document.createElement("div");
  notice.id = "update-notice";
  notice.className = "update-notice";
  notice.innerHTML = `
    <span>Nouvelle version disponible</span>
    <button class="button secondary" type="button" data-action="apply-update">Mettre à jour</button>
  `;
  notice.querySelector("[data-action='apply-update']").addEventListener("click", () => {
    if (waitingServiceWorker) {
      waitingServiceWorker.postMessage({ type: "SKIP_WAITING" });
    } else {
      window.location.reload();
    }
  });
  document.body.appendChild(notice);
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
  if (screen !== "route") routeEditorDirty = false;

  if (screen === "course" && id === "new") {
    renderCourseForm();
  } else if (screen === "course" && id) {
    renderCourseForm(id);
  } else if (screen === "splits" && id) {
    renderSplits(id);
  } else if (screen === "summary" && id) {
    renderSummary(id);
  } else if (screen === "route" && id) {
    renderRouteEditor(id);
  } else if (screen === "live") {
    renderLive();
  } else if (screen === "resume") {
    renderResumeRun();
  } else if (screen === "install") {
    renderInstallHelp();
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

  const hasCourses = courses.length > 0;

  app.innerHTML = `
    <section class="stack home-screen">
      <div class="home-hero app-hero">
        <div class="hero-brand">
          <img class="app-logo large" src="assets/logo.png" alt="Race Split Assistant">
          <div>
            <p class="section-kicker">Sans GPS · Offline · Mobile-first</p>
            <h2>Prépare ta stratégie de course</h2>
          </div>
        </div>
        <p>Crée ta course, dessine ton parcours et organise tes temps de passage avant le départ.</p>
        <div class="actions hero-actions">
          <button class="button" type="button" data-route="#course/new">${hasCourses ? "Nouvelle course" : "Créer une course"}</button>
        </div>
      </div>
      ${renderHomeSteps()}
      ${activeRun && activeRun.status !== "finished" ? `
        <div class="notice">
          Une course est en cours. Le chrono est sauvegardé localement.
          <button class="button success" type="button" data-route="#live">Reprendre le live</button>
        </div>
      ` : ""}
      ${renderInstallCard()}
      <section class="course-section">
        <div class="section-title">
          <div>
            <p class="section-kicker">Stratégies</p>
            <h2>${hasCourses ? "Tes courses" : "Aucune course pour le moment"}</h2>
          </div>
          ${hasCourses ? `<button class="button compact" type="button" data-route="#course/new">Nouvelle course</button>` : ""}
        </div>
        ${hasCourses ? `
          <div class="course-grid">${courses.map(renderCourseCard).join("")}</div>
        ` : `
          <div class="empty-state compact-empty">
            <h2>Commence par créer ta première course.</h2>
            <p>Tu pourras ensuite dessiner le parcours, préparer tes temps de passage et lancer le mode live le jour J.</p>
            <button class="button" type="button" data-route="#course/new">Créer ma première course</button>
          </div>
        `}
      </section>
    </section>
  `;

  const exportButton = app.querySelector("[data-action='export']");
  if (exportButton) exportButton.addEventListener("click", exportCourses);
  const importInput = app.querySelector("#import-json");
  if (importInput) importInput.addEventListener("change", importCourses);
  const installButton = app.querySelector("[data-action='install-app']");
  if (installButton) installButton.addEventListener("click", installApp);

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

function renderHomeSteps() {
  const steps = [
    {
      number: "1",
      title: "Crée ta course",
      text: "Nom, distance et objectif chrono clair."
    },
    {
      number: "2",
      title: "Dessine ton parcours",
      text: "Place les points importants sur une base visuelle simple."
    },
    {
      number: "3",
      title: "Prépare tes temps",
      text: "Ajoute ravitos, repères et temps de passage."
    }
  ];

  return `
    <div class="home-steps">
      ${steps.map((step) => `
        <article class="step-card">
          <span>${step.number}</span>
          <div>
            <h3>${escapeHtml(step.title)}</h3>
            <p>${escapeHtml(step.text)}</p>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function detectInstallContext() {
  const userAgent = navigator.userAgent || "";
  const isIos = /iphone|ipad|ipod/i.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

  return {
    isIos,
    isAndroid,
    isStandalone,
    supportsPrompt: Boolean(deferredInstallPrompt)
  };
}

function renderInstallCard() {
  const context = detectInstallContext();

  if (context.isStandalone) {
    return `
      <div class="card install-card compact-installed">
        <h2>Application installée</h2>
        <p>Race Split Assistant est lancée comme une application.</p>
      </div>
    `;
  }

  if (context.supportsPrompt) {
    return `
      <div class="card install-card">
        <h2>Installer l’application</h2>
        <p>Ajoute Race Split Assistant à ton écran d’accueil pour l’utiliser comme une application, même hors connexion.</p>
        <div class="actions two">
          <button class="button" type="button" data-action="install-app">Installer l’application</button>
          <button class="button secondary" type="button" data-route="#install">Télécharger</button>
        </div>
      </div>
    `;
  }

  if (context.isIos) {
    return `
      <div class="card install-card">
        <h2>Installer l’application</h2>
        <p>Ajoute Race Split Assistant à ton écran d’accueil pour l’utiliser comme une application, même hors connexion.</p>
        <ol class="install-steps">
          <li>Ouvre le site dans Safari.</li>
          <li>Appuie sur Partager.</li>
          <li>Choisis Sur l’écran d’accueil.</li>
          <li>Appuie sur Ajouter.</li>
        </ol>
        <button class="button secondary" type="button" data-route="#install">Télécharger</button>
      </div>
    `;
  }

  return `
      <div class="card install-card">
        <h2>Installer l’application</h2>
        <p>Si ton navigateur le propose, utilise son menu puis Ajouter à l’écran d’accueil. L’app fonctionnera hors connexion après un premier chargement.</p>
        <button class="button secondary" type="button" data-route="#install">Télécharger</button>
      </div>
    `;
}

function renderInstallHelp() {
  setTitle("Installer");
  app.innerHTML = `
    <section class="stack">
      <div class="card install-card">
        <img class="app-logo" src="assets/logo.png" alt="Race Split Assistant">
        <h2>Installer Race Split Assistant</h2>
        <p>Race Split Assistant est une PWA. Elle s’ajoute à l’écran d’accueil depuis le navigateur et fonctionne hors connexion après un premier chargement.</p>
      </div>
      <div class="card">
        <h2>Android</h2>
        <ol class="install-steps">
          <li>Ouvre le lien GitHub Pages dans Chrome.</li>
          <li>Appuie sur Installer l’application si le bouton apparaît.</li>
          <li>Sinon, ouvre le menu Chrome puis Ajouter à l’écran d’accueil.</li>
        </ol>
      </div>
      <div class="card">
        <h2>iPhone</h2>
        <ol class="install-steps">
          <li>Ouvre le lien dans Safari.</li>
          <li>Appuie sur Partager.</li>
          <li>Choisis Sur l’écran d’accueil.</li>
          <li>Appuie sur Ajouter.</li>
        </ol>
      </div>
      <div class="card">
        <h2>À savoir</h2>
        <p>L’app ne tourne pas comme une application native en arrière-plan. Le chrono reste fiable car il est recalculé avec Date.now() quand tu reviens dans l’app.</p>
        <p>Les courses, l’historique live, les pauses et la distance estimée restent sauvegardés localement sur ce navigateur.</p>
      </div>
      <button class="button secondary" type="button" data-route="#home">Retour accueil</button>
    </section>
  `;
}

async function installApp() {
  if (!deferredInstallPrompt) return;
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  promptEvent.prompt();
  await promptEvent.userChoice.catch(() => null);
  if ((location.hash || "#home") === "#home") renderHome();
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
  const routeStatus = getRouteDesignStatus(course);
  const splitStatus = getSplitPreparationStatus(course);
  const routeButtonLabel = routeStatus.ready ? "Modifier le parcours" : "Dessiner";
  const completion = getCourseCompletion(course);

  return `
    <article class="card course-card ${completion.readyForLive ? "is-ready" : ""}">
      <div class="card-header">
        <div>
          <h2>${escapeHtml(course.name)}</h2>
          <div class="tag-row">
            <span class="tag">${escapeHtml(course.type)}</span>
            <span class="tag ${routeStatus.className}">${routeStatus.label}</span>
            <span class="tag ${splitStatus.className}">${splitStatus.label}</span>
            ${status ? `<span class="tag ${status.className}">${status.label}</span>` : ""}
          </div>
        </div>
      </div>
      <div class="course-progress" aria-label="Progression de préparation">
        <span style="width: ${completion.percent}%"></span>
      </div>
      <div class="meta-grid">
        <div class="metric"><span>Distance</span><strong>${formatKm(course.distanceKm)}</strong></div>
        <div class="metric"><span>Objectif</span><strong>${formatTime(course.targetSeconds)}</strong></div>
        <div class="metric"><span>Temps de passage</span><strong>${course.checkpoints.length}</strong></div>
      </div>
      <div class="actions two course-actions">
        <button class="button" type="button" data-action="view-course" data-id="${course.id}">Ouvrir</button>
        <button class="button secondary" type="button" data-route="#route/${course.id}">${routeButtonLabel}</button>
      </div>
      <div class="actions two course-actions">
        <button class="button ghost" type="button" data-action="duplicate-course" data-id="${course.id}">Dupliquer</button>
        <button class="button danger" type="button" data-action="delete-course" data-id="${course.id}">Supprimer</button>
      </div>
    </article>
  `;
}

function getCourseCompletion(course) {
  const routeReady = getRouteDesignStatus(course).ready;
  const splitsReady = course.checkpoints.length > 0;
  const done = 1 + (routeReady ? 1 : 0) + (splitsReady ? 1 : 0);
  return {
    percent: Math.round((done / 3) * 100),
    readyForLive: splitsReady,
    routeReady,
    splitsReady
  };
}

function getRouteDesignStatus(course) {
  const routeDesign = normalizeRouteDesign(course.routeDesign);
  const ready = routeDesign.points.length >= 2 && routeDesign.segments.length >= 1;
  return ready
    ? { ready, label: "Parcours prêt", className: "status-good" }
    : { ready, label: "Parcours à dessiner", className: "status-neutral" };
}

function getSplitPreparationStatus(course) {
  return course.checkpoints.length
    ? { ready: true, label: "Temps de passage prêts", className: "status-good" }
    : { ready: false, label: "Temps de passage à préparer", className: "status-warning" };
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
    <section class="card guided-form-card">
      <form class="form" id="course-form" novalidate>
        <div id="form-errors"></div>
        <div class="form-intro">
          <p class="section-kicker">${editing ? "Modifier" : "Assistant"}</p>
          <h2>${editing ? "Ajuster la course" : "Créer une course en 4 étapes"}</h2>
          <p>${editing ? "Modifie les informations principales sans toucher aux parcours ou temps de passage déjà préparés." : "Renseigne l’essentiel, puis choisis si tu veux dessiner le parcours maintenant ou plus tard."}</p>
        </div>
        <div class="form-section section-course">
          <div>
            <p class="section-kicker">Étape 1</p>
            <h2>Informations principales</h2>
          </div>
          <div class="grid two">
            <div class="field">
              <label for="name">Nom de la course</label>
              <input id="name" name="name" required value="${escapeAttr(course.name)}">
            </div>
            <div class="field">
              <label for="distanceKm">Distance totale</label>
              <input id="distanceKm" name="distanceKm" inputmode="decimal" required value="${escapeAttr(course.distanceKm || "")}">
              <small>Exemple : 19.7</small>
            </div>
          </div>
        </div>

        <div class="form-section section-objective">
          <div>
            <p class="section-kicker">Étape 2</p>
            <h2>Objectif chrono</h2>
          </div>
          ${renderDurationPicker("target", course.targetSeconds, "Objectif")}
        </div>

        <div class="form-section section-course">
          <div>
            <p class="section-kicker">Détails</p>
            <h2>Contexte de course</h2>
          </div>
          <div class="field">
            <label for="type">Type de course</label>
            <select id="type" name="type">${options(courseTypes, course.type)}</select>
          </div>
          <div class="field">
            <label for="notes">Notes personnelles</label>
            <textarea id="notes" name="notes">${escapeHtml(course.notes || "")}</textarea>
          </div>
        </div>

        ${editing ? "" : `
          <div class="form-section section-route">
            <div>
              <p class="section-kicker">Étape 3</p>
              <h2>Parcours</h2>
              <p class="muted-text">Quand veux-tu dessiner le parcours ?</p>
            </div>
            <div class="choice-grid">
              <label class="choice-card">
                <input type="radio" name="routeTiming" value="later" checked>
                <span>
                  <strong>Plus tard</strong>
                  <small>Créer la course maintenant et dessiner le parcours ensuite.</small>
                </span>
              </label>
              <label class="choice-card">
                <input type="radio" name="routeTiming" value="now">
                <span>
                  <strong>Maintenant</strong>
                  <small>Créer la course puis ouvrir directement l’éditeur de parcours.</small>
                </span>
              </label>
            </div>
          </div>
          <div class="form-section section-splits">
            <div>
              <p class="section-kicker">Étape 4</p>
              <h2>Temps de passage</h2>
              <p class="muted-text">Veux-tu préparer tes checkpoints tout de suite ?</p>
            </div>
            <div class="choice-grid">
              <label class="choice-card choice-card-splits">
                <input type="radio" name="splitTiming" value="later" checked>
                <span>
                  <strong>Préparer plus tard</strong>
                  <small>Créer la course puis revenir aux temps de passage depuis le tableau de bord.</small>
                </span>
              </label>
              <label class="choice-card choice-card-splits">
                <input type="radio" name="splitTiming" value="now">
                <span>
                  <strong>Préparer maintenant</strong>
                  <small>Créer la course puis ouvrir directement l’interface des temps de passage.</small>
                </span>
              </label>
            </div>
          </div>
        `}
        <div class="actions two">
          <button class="button" type="submit">Enregistrer</button>
          <button class="button secondary" type="button" data-route="${editing ? `#summary/${course.id}` : "#home"}">Annuler</button>
        </div>
      </form>
    </section>
  `;

  app.querySelector("#course-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveCourseFromForm(courseId);
  });
  bindDurationPicker("target", "Objectif");
  bindChoiceCards();
}

function bindChoiceCards() {
  const cards = Array.from(app.querySelectorAll(".choice-card"));
  if (!cards.length) return;

  const refresh = () => {
    cards.forEach((card) => {
      const input = card.querySelector("input");
      card.classList.toggle("is-selected", Boolean(input && input.checked));
    });
  };

  cards.forEach((card) => {
    const input = card.querySelector("input");
    if (input) input.addEventListener("change", refresh);
  });
  refresh();
}

function saveCourseFromForm(courseId) {
  const form = app.querySelector("#course-form");
  const formData = new FormData(form);
  const name = String(formData.get("name") || "").trim();
  const distanceKm = parseDecimal(formData.get("distanceKm"));
  const targetSeconds = readDurationFromForm(formData, "target");
  const type = String(formData.get("type") || "Autre");
  const notes = String(formData.get("notes") || "").trim();
  const routeTiming = String(formData.get("routeTiming") || "later");
  const splitTiming = String(formData.get("splitTiming") || "later");

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
  showToast(courseId ? "Course mise à jour" : "Course créée", "success");
  if (!courseId && splitTiming === "now") {
    location.hash = `#splits/${course.id}`;
  } else if (!courseId && routeTiming === "now") {
    location.hash = `#route/${course.id}`;
  } else {
    location.hash = `#summary/${course.id}`;
  }
}

function renderSplits(courseId) {
  const course = findCourse(courseId);
  if (!course) return navigateHome();

  setTitle("Temps de passage");
  course.checkpoints.sort(sortByDistance);
  const metrics = calculateCourseMetrics(course);
  const alert = getLastCheckpointAlert(course);

  app.innerHTML = `
    ${renderScreenNav(course.id)}
    <section class="stack checkpoints-screen">
      <div class="card split-hero section-splits">
        <div>
          <p class="section-kicker">Temps de passage</p>
          <h2>${escapeHtml(course.name)}</h2>
          <p class="muted-text">Ajoute les points importants de ta course : ravitos, grosses montées, changements de rythme ou repères personnels.</p>
        </div>
        <div class="meta-grid">
          <div class="metric"><span>Distance totale</span><strong>${formatKm(course.distanceKm)}</strong></div>
          <div class="metric"><span>Objectif</span><strong>${formatTime(course.targetSeconds)}</strong></div>
          <div class="metric"><span>Allure moyenne</span><strong>${formatPace(metrics.globalPace)}</strong></div>
          <div class="metric"><span>Temps de passage</span><strong>${course.checkpoints.length}</strong></div>
        </div>
        <button class="button add-checkpoint-button" type="button" data-action="focus-checkpoint-form">Ajouter un temps de passage</button>
      </div>
      ${renderCheckpointPlanningContext(course)}
      ${renderCheckpointProgressBars(course)}
      ${alert ? `<div class="notice warning">${escapeHtml(alert)}</div>` : ""}
      <div class="card checkpoint-editor is-hidden" id="checkpoint-editor"></div>
      <section class="split-list-section">
        <div class="section-title">
          <div>
            <p class="section-kicker">Plan actuel</p>
            <h2>Checkpoints</h2>
          </div>
          <span class="tag status-splits">${course.checkpoints.length} point${course.checkpoints.length > 1 ? "s" : ""}</span>
        </div>
        <div class="split-list">
          ${course.checkpoints.length ? course.checkpoints.map((checkpoint, index) => renderSplitCard(course, checkpoint, index)).join("") : `<div class="empty">Aucun temps de passage pour cette course. Commence par ajouter le départ, un ravito ou un repère important.</div>`}
        </div>
      </section>
      ${renderCheckpointPlanSummary(course)}
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

function getCheckpointPlanState(course) {
  const ordered = [...course.checkpoints].sort(sortByDistance);
  const last = ordered[ordered.length - 1] || null;
  const coveredDistance = last ? last.distanceKm : 0;
  const plannedSeconds = last ? last.targetSeconds : 0;
  return {
    ordered,
    last,
    coveredDistance,
    remainingDistance: Math.max(0, course.distanceKm - coveredDistance),
    plannedSeconds,
    remainingSeconds: course.targetSeconds - plannedSeconds
  };
}

function renderCheckpointPlanningContext(course) {
  const state = getCheckpointPlanState(course);
  return `
    <section class="card checkpoint-context section-splits">
      <div class="section-title compact-title">
        <div>
          <p class="section-kicker">Où en est le plan ?</p>
          <h2>Contexte de progression</h2>
        </div>
      </div>
      <div class="meta-grid">
        <div class="metric"><span>Distance totale</span><strong>${formatKm(course.distanceKm)}</strong></div>
        <div class="metric"><span>Objectif chrono</span><strong>${formatTime(course.targetSeconds)}</strong></div>
        <div class="metric"><span>Dernier point</span><strong>${state.last ? escapeHtml(state.last.name) : "Aucun"}</strong></div>
        <div class="metric"><span>Déjà couvert</span><strong>${formatKm(state.coveredDistance)}</strong></div>
        <div class="metric"><span>Encore à parcourir</span><strong>${formatKm(state.remainingDistance)}</strong></div>
        <div class="metric"><span>Temps planifié</span><strong>${formatTime(state.plannedSeconds)}</strong></div>
        <div class="metric"><span>Temps restant</span><strong>${formatSignedRemaining(state.remainingSeconds)}</strong></div>
        <div class="metric"><span>Checkpoints créés</span><strong>${course.checkpoints.length}</strong></div>
      </div>
      ${state.remainingDistance > 0.01 ? `<p class="context-hint">Il reste encore ${formatKm(state.remainingDistance)} à planifier.</p>` : `<p class="context-hint is-complete">La distance de course est couverte par tes checkpoints.</p>`}
    </section>
  `;
}

function renderCheckpointProgressBars(course) {
  const ordered = [...course.checkpoints].sort(sortByDistance);
  return `
    <section class="card checkpoint-bars section-splits">
      <div class="section-title compact-title">
        <div>
          <p class="section-kicker">Visualisation</p>
          <h2>Distance et temps</h2>
        </div>
      </div>
      ${renderPlanBar("Distance", "0 km", formatKm(course.distanceKm), ordered, (checkpoint) => checkpoint.distanceKm / course.distanceKm)}
      ${renderPlanBar("Temps", "00:00:00", formatTime(course.targetSeconds), ordered, (checkpoint) => checkpoint.targetSeconds / course.targetSeconds)}
    </section>
  `;
}

function renderPlanBar(label, startLabel, endLabel, checkpoints, getRatio) {
  return `
    <div class="plan-bar-group">
      <div class="plan-bar-label">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(startLabel)} → ${escapeHtml(endLabel)}</span>
      </div>
      <div class="plan-bar-track">
        ${checkpoints.map((checkpoint, index) => {
          const left = clampPercent(getRatio(checkpoint) * 100);
          return `<span class="plan-marker" style="left: ${left}%" title="${escapeAttr(`${index + 1}. ${checkpoint.name}`)}"></span>`;
        }).join("")}
      </div>
    </div>
  `;
}

function renderCheckpointPlanSummary(course) {
  const state = getCheckpointPlanState(course);
  const metrics = calculateCourseMetrics(course);
  return `
    <section class="card plan-summary section-splits">
      <div>
        <p class="section-kicker">Résumé automatique</p>
        <h2>Plan actuel</h2>
      </div>
      <div class="meta-grid">
        <div class="metric"><span>Distance planifiée</span><strong>${formatKm(state.coveredDistance)} / ${formatKm(course.distanceKm)}</strong></div>
        <div class="metric"><span>Distance restante</span><strong>${formatKm(state.remainingDistance)}</strong></div>
        <div class="metric"><span>Temps utilisé</span><strong>${formatTime(state.plannedSeconds)} / ${formatTime(course.targetSeconds)}</strong></div>
        <div class="metric"><span>Temps restant</span><strong>${formatSignedRemaining(state.remainingSeconds)}</strong></div>
        <div class="metric"><span>Allure cible globale</span><strong>${formatPace(metrics.globalPace)}</strong></div>
        <div class="metric"><span>Nombre de checkpoints</span><strong>${course.checkpoints.length}</strong></div>
      </div>
    </section>
  `;
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
      <div class="form-intro split-form-intro">
        <p class="section-kicker">${checkpoint ? "Modification" : "Nouveau point"}</p>
        <h2>${checkpoint ? "Modifier ce temps de passage" : "Ajouter un temps de passage"}</h2>
        <p>La distance correspond à la position du point depuis le départ. Le temps cible correspond au chrono que tu veux afficher en arrivant à ce point.</p>
      </div>
      <div class="grid two">
        <div class="field">
          <label for="checkpointName">Nom du point</label>
          <input id="checkpointName" name="checkpointName" required value="${escapeAttr(item.name)}">
        </div>
        <div class="field">
          <label for="checkpointDistance">Distance depuis le départ</label>
          <input id="checkpointDistance" name="checkpointDistance" inputmode="decimal" required value="${escapeAttr(item.distanceKm)}">
          <small>Exemple : 8.5 pour un point situé à 8,5 km du départ.</small>
        </div>
      </div>
      <div class="form-section compact">
        <div>
          <h3>Temps cible à ce point</h3>
          <p class="muted-text">Chrono prévu à ce point de passage.</p>
        </div>
        ${renderDurationPicker("checkpointTarget", item.targetSeconds, "Temps cible")}
      </div>
      <div class="checkpoint-preview" id="checkpoint-preview"></div>
      <div class="grid two">
        <div class="field">
          <label for="zoneType">Type de zone</label>
          <select id="zoneType" name="zoneType">${options(zoneTypes, item.zoneType)}</select>
        </div>
        <div class="field">
          <label for="strategy">Stratégie</label>
          <select id="strategy" name="strategy">${options(strategies, item.strategy)}</select>
        </div>
      </div>
      <div class="field" id="aid-field">
        <label for="aidSeconds">Temps ravito max en secondes</label>
        <input id="aidSeconds" name="aidSeconds" inputmode="numeric" value="${escapeAttr(item.aidSeconds || "")}">
      </div>
      <div class="field">
        <label for="advice">Note optionnelle</label>
        <textarea id="advice" name="advice">${escapeHtml(item.advice || "")}</textarea>
      </div>
      <div class="actions two">
        <button class="button" type="submit">Enregistrer</button>
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
  const targetSeconds = readDurationFromForm(formData, "checkpointTarget");
  const zoneType = String(formData.get("zoneType") || "Autre");
  const strategy = String(formData.get("strategy") || "Libre");
  const advice = String(formData.get("advice") || "").trim();
  const aidSeconds = Math.max(0, Math.round(parseDecimal(formData.get("aidSeconds")) || 0));

  const errors = [];
  if (!name) errors.push("Le nom du temps de passage est obligatoire.");
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

  const draftMessages = getCheckpointDraftMessages(course, { checkpointId, distanceKm, targetSeconds });
  draftMessages
    .filter((message) => message.level === "danger")
    .forEach((message) => errors.push(message.text));

  const otherCheckpoints = course.checkpoints.filter((item) => item.id !== checkpointId);
  const ordered = [...otherCheckpoints, candidate].sort(sortByDistance);
  // Les splits sont calculés sur l’ordre de distance : il doit rester strict.
  const orderErrors = validateCheckpointOrder(ordered);
  orderErrors.forEach((error) => {
    if (!errors.includes(error)) errors.push(error);
  });

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
  showToast("Temps de passage enregistré", "success");
  renderSplits(courseId);
}

function showCheckpointForm(course, checkpointId = null) {
  const checkpoint = checkpointId ? course.checkpoints.find((item) => item.id === checkpointId) : null;
  if (checkpointId && !checkpoint) return;

  const card = app.querySelector("#checkpoint-editor");
  if (!card) return;

  card.classList.remove("is-hidden");
  card.innerHTML = renderCheckpointForm(course, checkpoint);
  card.querySelector("#checkpoint-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveCheckpointFromForm(course.id);
  });
  card.querySelector("[data-action='clear-checkpoint']").addEventListener("click", () => hideCheckpointForm(course.id));
  card.querySelector("#zoneType").addEventListener("change", toggleAidField);
  bindDurationPicker("checkpointTarget", "Temps cible");
  bindCheckpointPreview(course);
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

function bindCheckpointPreview(course) {
  const form = app.querySelector("#checkpoint-form");
  const preview = app.querySelector("#checkpoint-preview");
  if (!form || !preview) return;

  const update = () => {
    preview.innerHTML = renderCheckpointPreview(course, readCheckpointDraft(form));
  };

  form.querySelectorAll("input, select, textarea").forEach((field) => {
    field.addEventListener("input", update);
    field.addEventListener("change", update);
  });
  update();
}

function readCheckpointDraft(form) {
  const formData = new FormData(form);
  return {
    checkpointId: String(formData.get("checkpointId") || ""),
    distanceKm: parseDecimal(formData.get("checkpointDistance")),
    targetSeconds: readDurationFromForm(formData, "checkpointTarget")
  };
}

function renderCheckpointPreview(course, draft) {
  const previous = getPreviousCheckpointForDraft(course, draft);
  const previousDistance = previous ? previous.distanceKm : 0;
  const previousSeconds = previous ? previous.targetSeconds : 0;
  const hasDistance = Number.isFinite(draft.distanceKm);
  const hasTime = Number.isFinite(draft.targetSeconds);
  const segmentDistance = hasDistance ? draft.distanceKm - previousDistance : null;
  const segmentSeconds = hasTime ? draft.targetSeconds - previousSeconds : null;
  const remainingDistance = hasDistance ? course.distanceKm - draft.distanceKm : null;
  const remainingSeconds = hasTime ? course.targetSeconds - draft.targetSeconds : null;
  const warnings = getCheckpointDraftMessages(course, draft, previous);

  return `
    <div class="preview-header">
      <div>
        <p class="section-kicker">Aperçu automatique</p>
        <h3>Portion définie</h3>
      </div>
      <span class="tag ${warnings.some((item) => item.level === "danger") ? "status-danger" : warnings.length ? "status-warning" : "status-good"}">${warnings.length ? "À vérifier" : "Cohérent"}</span>
    </div>
    <div class="meta-grid">
      <div class="metric"><span>Depuis le point précédent</span><strong>${previous ? escapeHtml(previous.name) : "Départ de course"}</strong></div>
      <div class="metric"><span>Segment</span><strong>${Number.isFinite(segmentDistance) ? formatKm(Math.max(0, segmentDistance)) : "N/A"}</strong></div>
      <div class="metric"><span>Temps segment</span><strong>${Number.isFinite(segmentSeconds) ? formatTime(Math.max(0, segmentSeconds)) : "N/A"}</strong></div>
      <div class="metric"><span>Allure segment</span><strong>${Number.isFinite(segmentDistance) && Number.isFinite(segmentSeconds) && segmentDistance > 0 ? formatPace(segmentSeconds / segmentDistance) : "N/A"}</strong></div>
      <div class="metric"><span>Distance restante</span><strong>${Number.isFinite(remainingDistance) ? formatKm(Math.max(0, remainingDistance)) : "N/A"}</strong></div>
      <div class="metric"><span>Temps restant</span><strong>${Number.isFinite(remainingSeconds) ? formatSignedRemaining(remainingSeconds) : "N/A"}</strong></div>
    </div>
    <div class="checkpoint-messages">
      ${warnings.length ? warnings.map((item) => `<p class="inline-message ${item.level}">${escapeHtml(item.text)}</p>`).join("") : `<p class="inline-message good">Ce temps de passage est cohérent avec le plan actuel.</p>`}
    </div>
  `;
}

function getPreviousCheckpointForDraft(course, draft) {
  const others = course.checkpoints
    .filter((checkpoint) => checkpoint.id !== draft.checkpointId)
    .sort(sortByDistance);
  if (!others.length) return null;
  if (!draft.checkpointId) return others[others.length - 1];
  if (!Number.isFinite(draft.distanceKm)) return others[others.length - 1];
  return [...others].reverse().find((checkpoint) => checkpoint.distanceKm < draft.distanceKm) || null;
}

function getNextCheckpointForDraft(course, draft) {
  if (!draft.checkpointId || !Number.isFinite(draft.distanceKm)) return null;
  return course.checkpoints
    .filter((checkpoint) => checkpoint.id !== draft.checkpointId)
    .sort(sortByDistance)
    .find((checkpoint) => checkpoint.distanceKm > draft.distanceKm) || null;
}

function getCheckpointDraftMessages(course, draft, previous = getPreviousCheckpointForDraft(course, draft)) {
  const messages = [];
  const next = getNextCheckpointForDraft(course, draft);

  if (!Number.isFinite(draft.distanceKm)) {
    messages.push({ level: "danger", text: "La distance doit être renseignée." });
    return messages;
  }
  if (draft.distanceKm < 0) messages.push({ level: "danger", text: "La distance ne peut pas être négative." });
  if (draft.distanceKm > course.distanceKm + 0.001) messages.push({ level: "danger", text: "Ce checkpoint dépasse la distance totale." });
  if (previous && draft.distanceKm <= previous.distanceKm) messages.push({ level: "danger", text: "La distance doit être supérieure au checkpoint précédent." });
  if (next && draft.distanceKm >= next.distanceKm) messages.push({ level: "danger", text: "La distance doit rester avant le checkpoint suivant." });

  if (!Number.isFinite(draft.targetSeconds)) {
    messages.push({ level: "danger", text: "Le temps cible doit être renseigné." });
    return messages;
  }
  if (previous && draft.targetSeconds <= previous.targetSeconds) messages.push({ level: "danger", text: "Le temps cible doit être supérieur au temps précédent." });
  if (next && draft.targetSeconds >= next.targetSeconds) messages.push({ level: "danger", text: "Le temps cible doit rester avant le checkpoint suivant." });
  if (draft.targetSeconds > course.targetSeconds) messages.push({ level: "warning", text: "Ce checkpoint dépasse l’objectif chrono." });

  const remainingDistance = course.distanceKm - draft.distanceKm;
  if (remainingDistance > 0.01) messages.push({ level: "info", text: `Il reste encore ${formatKm(remainingDistance)} à planifier.` });
  return messages;
}

function renderSplitCard(course, checkpoint, index) {
  const previous = course.checkpoints[index - 1] || null;
  const split = calculateSplit(previous, checkpoint);
  const zoneClass = `zone-${slug(checkpoint.zoneType)}`;
  const remainingDistance = Math.max(0, course.distanceKm - checkpoint.distanceKm);
  const remainingSeconds = course.targetSeconds - checkpoint.targetSeconds;

  return `
    <article class="card split-card checkpoint-row ${zoneClass}">
      <div class="card-header">
        <div class="checkpoint-title">
          <span class="checkpoint-number">${index + 1}</span>
          <div>
            <h3>${escapeHtml(checkpoint.name)}</h3>
            <p>${formatKm(checkpoint.distanceKm)} · ${formatTime(checkpoint.targetSeconds)}</p>
          </div>
        </div>
        <div class="tag-row">
          <span class="tag ${zoneTagClass(checkpoint.zoneType)}">${escapeHtml(checkpoint.zoneType)}</span>
        </div>
      </div>
      <div class="checkpoint-segment">
        <p>
          <strong>Segment précédent :</strong>
          ${formatKm(split.distanceKm)} en ${formatTime(split.seconds)} · ${formatPace(split.pace)}
        </p>
        <p>Encore ${formatKm(remainingDistance)} à parcourir · ${formatSignedRemaining(remainingSeconds)} avant l’objectif.</p>
      </div>
      <div class="meta-grid">
        <div class="metric"><span>Distance depuis départ</span><strong>${formatKm(checkpoint.distanceKm)}</strong></div>
        <div class="metric"><span>Temps cible</span><strong>${formatTime(checkpoint.targetSeconds)}</strong></div>
        <div class="metric"><span>Allure segment</span><strong>${formatPace(split.pace)}</strong></div>
        <div class="metric"><span>Distance restante</span><strong>${formatKm(remainingDistance)}</strong></div>
      </div>
      ${checkpoint.advice ? `<p class="checkpoint-note">${escapeHtml(checkpoint.advice)}</p>` : ""}
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
  const routeStatus = getRouteDesignStatus(course);
  const splitStatus = getSplitPreparationStatus(course);
  const routeDesign = normalizeRouteDesign(course.routeDesign);
  const completion = getCourseCompletion(course);

  app.innerHTML = `
    ${renderScreenNav(course.id)}
    <section class="stack dashboard-screen">
      <div class="card dashboard-hero">
        <div class="dashboard-title-row">
          <div>
            <p class="section-kicker">Tableau de bord</p>
            <h2>${escapeHtml(course.name)}</h2>
          </div>
          <span class="tag ${completion.readyForLive ? "status-good" : "status-neutral"}">${completion.readyForLive ? "Prêt pour le live" : "Préparation en cours"}</span>
        </div>
        <div class="meta-grid">
          <div class="metric"><span>Distance</span><strong>${formatKm(course.distanceKm)}</strong></div>
          <div class="metric"><span>Objectif</span><strong>${formatTime(course.targetSeconds)}</strong></div>
          <div class="metric"><span>Allure globale</span><strong>${formatPace(metrics.globalPace)}</strong></div>
          <div class="metric"><span>Type</span><strong>${escapeHtml(course.type)}</strong></div>
        </div>
        <div class="course-progress wide" aria-label="Progression de préparation">
          <span style="width: ${completion.percent}%"></span>
        </div>
        ${course.notes ? `<p>${escapeHtml(course.notes)}</p>` : ""}
      </div>
      ${alert ? `<div class="notice warning">${escapeHtml(alert)}</div>` : ""}
      ${renderPreparationChecklist(course, routeStatus, splitStatus)}
      <div class="dashboard-grid">
        <article class="card dashboard-card status-card">
          <div class="card-header">
            <div>
              <p class="section-kicker">Étape 1</p>
              <h2>Parcours</h2>
            </div>
            <span class="tag ${routeStatus.className}">${routeStatus.label}</span>
          </div>
          ${routeStatus.ready ? `
            <p>Parcours dessiné.</p>
            <div class="meta-grid">
              <div class="metric"><span>Points</span><strong>${routeDesign.points.length}</strong></div>
              <div class="metric"><span>Segments</span><strong>${routeDesign.segments.length}</strong></div>
            </div>
            <button class="button secondary" type="button" data-route="#route/${course.id}">Modifier le parcours</button>
          ` : `
            <p class="muted-text">Aucun parcours dessiné pour cette course.</p>
            <button class="button" type="button" data-route="#route/${course.id}">Dessiner le parcours</button>
          `}
        </article>

        <article class="card dashboard-card status-card">
          <div class="card-header">
            <div>
              <p class="section-kicker">Étape 2</p>
              <h2>Temps de passage</h2>
            </div>
            <span class="tag ${splitStatus.className}">${splitStatus.label}</span>
          </div>
          ${course.checkpoints.length ? `
            <div class="meta-grid">
              <div class="metric"><span>Nombre</span><strong>${course.checkpoints.length}</strong></div>
              <div class="metric"><span>Ravitos prévus</span><strong>${formatShortDuration(metrics.totalAidSeconds)}</strong></div>
            </div>
            <button class="button secondary" type="button" data-route="#splits/${course.id}">Modifier les temps</button>
          ` : `
            <p class="muted-text">Aucun temps de passage préparé.</p>
            <button class="button" type="button" data-route="#splits/${course.id}">Préparer les temps</button>
          `}
        </article>

        <article class="card dashboard-card status-card">
          <div>
            <p class="section-kicker">Réglages</p>
            <h2>Objectif chrono</h2>
          </div>
          <div class="meta-grid">
            <div class="metric"><span>Chrono</span><strong>${formatTime(course.targetSeconds)}</strong></div>
            <div class="metric"><span>Allure moyenne</span><strong>${formatPace(metrics.globalPace)}</strong></div>
          </div>
          <button class="button secondary" type="button" data-route="#course/${course.id}/edit">Modifier la course</button>
        </article>

        <article class="card dashboard-card status-card live-card">
          <div>
            <p class="section-kicker">Étape 3</p>
            <h2>Course en direct</h2>
          </div>
          <p class="muted-text">${course.checkpoints.length ? "Lance le chrono manuel quand tu es au départ." : "Prépare au moins un temps de passage pour activer le live."}</p>
          <button class="button success" type="button" data-action="start-run" ${course.checkpoints.length ? "" : "disabled"}>Lancer le mode live</button>
        </article>
      </div>
      <div class="card">
        <h2>Zones importantes</h2>
        <div class="tag-row">
          ${importantZones.length ? importantZones.map((checkpoint) => `<span class="tag ${zoneTagClass(checkpoint.zoneType)}">${escapeHtml(checkpoint.name)} · ${escapeHtml(checkpoint.zoneType)}</span>`).join("") : `<span class="tag gray">Aucune zone particulière</span>`}
        </div>
      </div>
      <div class="split-list">
        ${course.checkpoints.length ? course.checkpoints.map((checkpoint, index) => renderSummaryCheckpoint(course, checkpoint, index)).join("") : `<div class="empty">Ajoute tes premiers temps de passage pour préparer la stratégie.</div>`}
      </div>
    </section>
  `;

  const startButton = app.querySelector("[data-action='start-run']");
  if (startButton) startButton.addEventListener("click", () => startRun(course.id));
}

function renderPreparationChecklist(course, routeStatus, splitStatus) {
  const items = [
    {
      label: "Course créée",
      state: "done",
      text: `${formatKm(course.distanceKm)} · objectif ${formatTime(course.targetSeconds)}`
    },
    {
      label: "Parcours dessiné",
      state: routeStatus.ready ? "done" : "todo",
      text: routeStatus.ready ? "Base visuelle prête." : "À dessiner pour mieux visualiser la course."
    },
    {
      label: "Temps de passage préparés",
      state: splitStatus.ready ? "done" : "todo",
      text: splitStatus.ready ? `${course.checkpoints.length} point${course.checkpoints.length > 1 ? "s" : ""} prêt${course.checkpoints.length > 1 ? "s" : ""}.` : "À préparer avant le mode live."
    },
    {
      label: "Prêt pour le live",
      state: splitStatus.ready ? "done" : "locked",
      text: splitStatus.ready ? "Le chrono manuel peut être lancé." : "Disponible après les temps de passage."
    }
  ];

  return `
    <div class="card prep-checklist">
      <div class="section-title compact-title">
        <div>
          <p class="section-kicker">Préparation</p>
          <h2>Avancer dans le bon ordre</h2>
        </div>
      </div>
      <div class="checklist-grid">
        ${items.map(renderChecklistItem).join("")}
      </div>
    </div>
  `;
}

function renderChecklistItem(item) {
  const label = item.state === "done" ? "Terminé" : item.state === "locked" ? "Bloqué" : "À faire";
  return `
    <div class="checklist-item is-${item.state}">
      <span class="check-dot"></span>
      <div>
        <strong>${escapeHtml(item.label)}</strong>
        <small>${escapeHtml(label)} · ${escapeHtml(item.text)}</small>
      </div>
    </div>
  `;
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

function renderRouteEditor(courseId) {
  const course = findCourse(courseId);
  if (!course) return navigateHome();

  setTitle("Dessiner le parcours");
  course.routeDesign = normalizeRouteDesign(course.routeDesign);
  let draft = structuredCloneSafe(course.routeDesign);
  let segmentMode = "line";
  let draggedPointId = null;
  let didDragPoint = false;
  routeEditorDirty = false;

  app.innerHTML = `
    ${renderScreenNav(course.id)}
    <section class="stack route-editor">
      <div class="card route-editor-header">
        <div>
          <p class="section-kicker">Parcours</p>
          <h2>${escapeHtml(course.name)}</h2>
          <p class="muted-text">Clique sur la zone pour placer des points. Chaque nouveau point sera relié au précédent.</p>
        </div>
        <button class="button secondary" type="button" data-route="#summary/${course.id}">Retour vers la course</button>
      </div>
      <div class="card route-tools toolbar route-toolbar">
        <div class="route-status-row">
          <strong id="route-mode-label">Mode actuel : Ligne droite</strong>
          <span id="route-count" class="tag gray">0 point · 0 segment</span>
        </div>
        <div class="actions two">
          <button class="button" type="button" data-mode="line">Ligne droite</button>
          <button class="button secondary" type="button" data-mode="curve">Courbe</button>
        </div>
        <div class="actions three">
          <button class="button secondary" type="button" data-action="undo-route-point">Annuler le dernier point</button>
          <button class="button danger secondary-danger" type="button" data-action="reset-route">Réinitialiser le parcours</button>
          <button class="button success" type="button" data-action="save-route">Sauvegarder</button>
        </div>
        <p id="route-save-status" class="route-save-status">Tout est sauvegardé.</p>
      </div>
      <div class="route-canvas-wrap">
        <svg id="route-canvas" class="route-canvas" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Zone de dessin du parcours"></svg>
      </div>
    </section>
  `;

  const svg = app.querySelector("#route-canvas");
  const status = app.querySelector("#route-save-status");
  const modeLabel = app.querySelector("#route-mode-label");
  const countLabel = app.querySelector("#route-count");
  const modeButtons = Array.from(app.querySelectorAll("[data-mode]"));

  function setMode(mode) {
    segmentMode = mode;
    modeButtons.forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("is-active", active);
      button.classList.toggle("secondary", !active);
    });
    modeLabel.textContent = `Mode actuel : ${mode === "curve" ? "Courbe" : "Ligne droite"}`;
  }

  function renderDraft() {
    countLabel.textContent = `${draft.points.length} ${draft.points.length > 1 ? "points" : "point"} · ${draft.segments.length} ${draft.segments.length > 1 ? "segments" : "segment"}`;
    const hint = getRouteEditorHint(draft);
    svg.innerHTML = `
      <defs>
        <pattern id="route-grid" width="5" height="5" patternUnits="userSpaceOnUse">
          <path d="M 5 0 L 0 0 0 5" fill="none" stroke="rgba(36,54,75,0.14)" stroke-width="0.22"/>
        </pattern>
      </defs>
      <rect width="100" height="100" fill="url(#route-grid)"></rect>
      ${hint ? `<text class="route-empty-hint" x="50" y="50">${hint}</text>` : ""}
      ${draft.segments.map((segment) => renderRouteSegmentSvg(draft, segment)).join("")}
      ${draft.points.map((point, index) => `
        <g class="route-point-group" data-point-id="${point.id}">
          <circle class="route-point ${index === 0 ? "is-start" : ""} ${index === draft.points.length - 1 ? "is-finish" : ""}" cx="${point.x}" cy="${point.y}" r="2.5"></circle>
          <text class="route-point-label" x="${point.x}" y="${Math.max(4, point.y - 4)}">${escapeHtml(getRoutePointLabel(index, draft.points.length))}</text>
        </g>
      `).join("")}
    `;

    svg.querySelectorAll("[data-point-id]").forEach((node) => {
      node.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        draggedPointId = node.dataset.pointId;
        didDragPoint = false;
        svg.setPointerCapture(event.pointerId);
      });
    });
  }

  function markRouteDirty(message = "Modifications non sauvegardées.") {
    routeEditorDirty = true;
    status.textContent = message;
    status.classList.add("is-dirty");
  }

  function addPoint(event) {
    if (didDragPoint) {
      didDragPoint = false;
      return;
    }
    if (draggedPointId || event.target.closest("[data-point-id]")) return;
    const position = getSvgPoint(svg, event);
    const point = {
      id: uid(),
      x: position.x,
      y: position.y
    };
    const previous = draft.points[draft.points.length - 1];
    draft.points.push(point);
    if (previous) {
      draft.segments.push(createRouteSegment(previous, point, segmentMode));
    }
    markRouteDirty();
    renderDraft();
  }

  svg.addEventListener("click", addPoint);
  svg.addEventListener("pointermove", (event) => {
    if (!draggedPointId) return;
    const point = draft.points.find((item) => item.id === draggedPointId);
    if (!point) return;
    const position = getSvgPoint(svg, event);
    point.x = position.x;
    point.y = position.y;
    didDragPoint = true;
    markRouteDirty();
    renderDraft();
  });
  svg.addEventListener("pointerup", () => {
    draggedPointId = null;
  });
  svg.addEventListener("pointercancel", () => {
    draggedPointId = null;
  });

  modeButtons.forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  app.querySelector("[data-action='undo-route-point']").addEventListener("click", () => {
    if (!draft.points.length) return;
    const removed = draft.points.pop();
    draft.segments = draft.segments.filter((segment) => segment.from !== removed.id && segment.to !== removed.id);
    markRouteDirty("Dernier point annulé. Pense à sauvegarder.");
    renderDraft();
  });
  app.querySelector("[data-action='reset-route']").addEventListener("click", () => {
    confirmDialog("Réinitialiser le dessin du parcours ?", () => {
      draft = createEmptyRouteDesign();
      markRouteDirty("Parcours réinitialisé. Pense à sauvegarder.");
      renderDraft();
    });
  });
  app.querySelector("[data-action='save-route']").addEventListener("click", () => {
    course.routeDesign = normalizeRouteDesign(draft);
    course.updatedAt = new Date().toISOString();
    saveCourses();
    draft = structuredCloneSafe(course.routeDesign);
    routeEditorDirty = false;
    status.textContent = "Parcours sauvegardé.";
    status.classList.remove("is-dirty");
    showToast("Parcours sauvegardé", "success");
    renderDraft();
    window.setTimeout(() => {
      if (!routeEditorDirty) status.textContent = "Tout est sauvegardé.";
    }, 1400);
  });

  setMode(segmentMode);
  renderDraft();
}

function getRouteEditorHint(draft) {
  if (!draft.points.length) return "Commence par cliquer ici pour placer le départ.";
  if (draft.points.length === 1) return "Ajoute un deuxième point pour créer ton premier segment.";
  return "";
}

function getRoutePointLabel(index, total) {
  if (index === 0) return "Départ";
  if (index === total - 1) return "Arrivée";
  return String(index + 1);
}

function renderRouteSegmentSvg(routeDesign, segment) {
  const from = routeDesign.points.find((point) => point.id === segment.from);
  const to = routeDesign.points.find((point) => point.id === segment.to);
  if (!from || !to) return "";

  if (segment.shape === "curve") {
    return `<path class="route-segment route-segment-curve" d="M ${from.x} ${from.y} Q ${segment.controlX} ${segment.controlY} ${to.x} ${to.y}"></path>`;
  }

  return `<line class="route-segment" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"></line>`;
}

function createRouteSegment(from, to, shape) {
  const segment = {
    id: uid(),
    from: from.id,
    to: to.id,
    shape: shape === "curve" ? "curve" : "line",
    controlX: null,
    controlY: null
  };

  if (segment.shape === "curve") {
    segment.controlX = clampRouteCoord((from.x + to.x) / 2);
    segment.controlY = clampRouteCoord(((from.y + to.y) / 2) - 10);
  }

  return segment;
}

function getSvgPoint(svg, event) {
  const rect = svg.getBoundingClientRect();
  return {
    x: clampRouteCoord(((event.clientX - rect.left) / rect.width) * 100),
    y: clampRouteCoord(((event.clientY - rect.top) / rect.height) * 100)
  };
}

function startRun(courseId) {
  const course = findCourse(courseId);
  if (!course || course.checkpoints.length === 0) {
    showModal("Ajoutez au moins un temps de passage avant de lancer la course.");
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
      <p class="wake-note">Si l’écran se verrouille, le chrono restera correct à la reprise.</p>
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
      ` : `<p>Tous les temps de passage sont validés.</p>`}
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
        ${activeRun.history.length ? activeRun.history.map(renderReportItem).join("") : `<div class="empty">Aucun temps de passage validé.</div>`}
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
      { label: "Passages", route: `#splits/${courseId}` },
      { label: "Résumé", route: `#summary/${courseId}` },
      { label: "Parcours", route: `#route/${courseId}` }
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
  showToast("Course dupliquée", "success");
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
    showToast("Course supprimée", "success");
    renderHome();
  });
}

function confirmDeleteCheckpoint(courseId, checkpointId) {
  confirmDialog("Supprimer ce temps de passage ?", () => {
    const course = findCourse(courseId);
    if (!course) return;
    course.checkpoints = course.checkpoints.filter((item) => item.id !== checkpointId);
    course.updatedAt = new Date().toISOString();
    saveCourses();
    showToast("Temps de passage supprimé", "success");
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
  showToast("Export JSON préparé", "success");
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
      showToast("Import terminé", "success");
      renderHome();
    } catch (error) {
      showToast("Import impossible", "danger");
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
    errors.push("Temps de passage hors distance.");
  }
  errors.push(...validateCheckpointOrder(course.checkpoints));
  return errors;
}

function getLastCheckpointAlert(course) {
  const last = course.checkpoints[course.checkpoints.length - 1];
  if (!last) return "";
  if (Math.abs(last.distanceKm - course.distanceKm) > 0.01) {
    return "Le dernier temps de passage ne correspond pas à la distance totale de la course.";
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

function secondsToParts(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  return {
    hours: Math.floor(safe / 3600),
    minutes: Math.floor((safe % 3600) / 60),
    seconds: safe % 60
  };
}

function renderDurationPicker(prefix, totalSeconds, label) {
  const parts = secondsToParts(totalSeconds);
  return `
    <div class="duration-picker" data-duration-picker="${prefix}">
      <div class="duration-field">
        <label for="${prefix}Hours">Heures</label>
        <input id="${prefix}Hours" name="${prefix}Hours" type="number" inputmode="numeric" min="0" step="1" value="${parts.hours}">
      </div>
      <div class="duration-field">
        <label for="${prefix}Minutes">Minutes</label>
        <input id="${prefix}Minutes" name="${prefix}Minutes" type="number" inputmode="numeric" min="0" max="59" step="1" value="${parts.minutes}">
      </div>
      <div class="duration-field">
        <label for="${prefix}Seconds">Secondes</label>
        <input id="${prefix}Seconds" name="${prefix}Seconds" type="number" inputmode="numeric" min="0" max="59" step="1" value="${parts.seconds}">
      </div>
      <p class="duration-preview" id="${prefix}-duration-preview">${escapeHtml(label)} : ${formatDurationLabel(totalSeconds)}</p>
    </div>
  `;
}

function bindDurationPicker(prefix, label) {
  const picker = app.querySelector(`[data-duration-picker="${prefix}"]`);
  if (!picker) return;

  const updatePreview = () => {
    const formData = new FormData(app.querySelector("form"));
    const seconds = readDurationFromForm(formData, prefix);
    const preview = app.querySelector(`#${prefix}-duration-preview`);
    if (preview) preview.textContent = `${label} : ${formatDurationLabel(seconds || 0)}`;
  };

  picker.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", updatePreview);
    input.addEventListener("blur", () => {
      const max = input.max ? Number(input.max) : null;
      let value = Math.max(Number(input.min || 0), Math.round(Number(input.value) || 0));
      if (max !== null && Number.isFinite(max)) value = Math.min(max, value);
      input.value = String(value);
      updatePreview();
    });
  });
  updatePreview();
}

function readDurationFromForm(formData, prefix) {
  const hours = Number(formData.get(`${prefix}Hours`));
  const minutes = Number(formData.get(`${prefix}Minutes`));
  const seconds = Number(formData.get(`${prefix}Seconds`));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  if (hours < 0 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) return null;
  return Math.round(hours) * 3600 + Math.round(minutes) * 60 + Math.round(seconds);
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

function formatSignedRemaining(seconds) {
  const safe = Math.round(Number(seconds) || 0);
  if (safe < 0) return `Dépassé de ${formatTime(Math.abs(safe))}`;
  return formatTime(safe);
}

function formatDurationLabel(seconds) {
  const parts = secondsToParts(seconds);
  return `${parts.hours}h ${String(parts.minutes).padStart(2, "0")}min ${String(parts.seconds).padStart(2, "0")}s`;
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

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
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

function showToast(message, type = "neutral") {
  let container = document.querySelector("#toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 220);
  }, 2600);
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
    routeDesign: createEmptyRouteDesign(),
    createdAt: "",
    updatedAt: ""
  };
}

function createEmptyRouteDesign() {
  return {
    points: [],
    segments: []
  };
}

function normalizeRouteDesign(routeDesign) {
  if (!routeDesign || typeof routeDesign !== "object") return createEmptyRouteDesign();

  const points = Array.isArray(routeDesign.points)
    ? routeDesign.points.map(normalizeRoutePoint).filter(Boolean)
    : [];
  const pointIds = new Set(points.map((point) => point.id));
  const segments = Array.isArray(routeDesign.segments)
    ? routeDesign.segments.map((segment) => normalizeRouteSegment(segment, pointIds)).filter(Boolean)
    : [];

  return { points, segments };
}

function normalizeRoutePoint(point) {
  if (!point || typeof point !== "object") return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    id: point.id || uid(),
    x: clampRouteCoord(x),
    y: clampRouteCoord(y)
  };
}

function normalizeRouteSegment(segment, pointIds) {
  if (!segment || typeof segment !== "object") return null;
  if (!pointIds.has(segment.from) || !pointIds.has(segment.to)) return null;
  const shape = segment.shape === "curve" ? "curve" : "line";
  const normalized = {
    id: segment.id || uid(),
    from: segment.from,
    to: segment.to,
    shape,
    controlX: null,
    controlY: null
  };
  if (shape === "curve") {
    normalized.controlX = clampRouteCoord(Number(segment.controlX));
    normalized.controlY = clampRouteCoord(Number(segment.controlY));
  }
  return normalized;
}

function clampRouteCoord(value) {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, Math.round(value * 1000) / 1000));
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
    routeDesign: normalizeRouteDesign(course.routeDesign),
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
