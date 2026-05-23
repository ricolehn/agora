import { initializeApp, getDatabase, ref, set, get, child, update, query, orderByChild, equalTo, runTransaction, remove, getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword, apiGet } from "./pocketbase-compat.js";
import { config } from "./config.js";

const app = initializeApp(config);
const db = getDatabase(app);
const auth = getAuth(app);

let people = [];
let donations = [];
let expenses = [];
let settings = { vollverdiener: 50, geringverdiener: 25, keinverdiener: 10, pausiert: 0, reportStartDate: null };
let settingsVersion = 0;
let currentPersonId = null;
let isAuthenticated = false;
let currentUser = null;
let users = [];
let chartDataCache = null;
let advancedConfigLoaded = false;
let advancedConfigAppName = null;
let superAdminPaymentRows = [];
let superAdminUserRows = [];
let currentEditedPayment = null;
let sseConnection = null;
let aiEnabled = false;
let aiMessages = [];
let aiStreaming = false;
const MAX_AI_CHAT_INPUT_HEIGHT = 120;

function connectSSE() {
    if (sseConnection) return;
    sseConnection = new EventSource(config.apiBaseUrl + '/stream', { withCredentials: true });
    sseConnection.addEventListener('data_update', () => {
        console.log("SSE: Data updated remotely, refreshing...");
        if (isAuthenticated) {
            loadData(true);
        }
    });
    sseConnection.onerror = () => {
        console.log("SSE error, reconnecting...");
        sseConnection.close();
        sseConnection = null;
        setTimeout(connectSSE, 5000);
    };
}

// ⚡ Bolt: Global variable to handle paginated display of historical transactions
let transactionPage = 1;
const transactionPerPage = 150;
let cachedTransactions = null;
let transactionTotalItems = 0;
let transactionSearchQuery = '';

// ⚡ Bolt: Global formatters for improved performance (avoiding re-initialization)
const numberFormatter = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const currencyFormatter = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dateFormatter = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const monthYearFormatter = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const dateTimeFormatter = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortDateFormatter = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });

// ⚡ Bolt: Fast path for ISO date formatting
// Avoids expensive Date parsing and Intl.DateTimeFormat overhead for standard database dates
function formatDateFast(dateInput) {
    if (!dateInput) return '';
    const dStr = String(dateInput);
    if (dStr.length === 10 && dStr[4] === '-' && dStr[7] === '-') {
        return `${dStr.substring(8, 10)}.${dStr.substring(5, 7)}.${dStr.substring(0, 4)}`;
    }
    const d = new Date(dateInput);
    return Number.isNaN(d.getTime()) ? 'Kein Datum' : dateFormatter.format(d);
}

document.addEventListener('DOMContentLoaded', async () => {
    const appName = config.appName || "Nova";

    // Update visual elements
    const headerEl = document.getElementById('app-name-header');
    if (headerEl) headerEl.textContent = appName;
    const loginHeaderEl = document.getElementById('login-app-name');
    if (loginHeaderEl) loginHeaderEl.textContent = appName;

    // Update document title
    document.title = appName;
});

window.showLogin = () => {
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('register-form').style.display = 'none';
    document.getElementById('btn-show-login').classList.add('active');
    document.getElementById('btn-show-register').classList.remove('active');
    document.getElementById('auth-subtitle').innerText = 'Melden Sie sich an, um fortzufahren';
    document.getElementById('auth-error').style.display = 'none';
};

window.showRegister = () => {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
    document.getElementById('btn-show-register').classList.add('active');
    document.getElementById('btn-show-login').classList.remove('active');
    document.getElementById('auth-subtitle').innerText = 'Erstellen Sie ein neues Konto';
    document.getElementById('auth-error').style.display = 'none';
    setButtonLoading('btn-login', false, null); // Reset login button state
};

// Helper: Changes button state to loading/disabled
function setButtonLoading(btnId, isLoading, loadingText = "Laden...") {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (isLoading) {
        btn.dataset.originalText = btn.innerText;
        btn.innerText = loadingText;
        btn.disabled = true;
    } else {
        if(btn.dataset.originalText) btn.innerText = btn.dataset.originalText;
        btn.disabled = false;
    }
}

// Helper: the backend can return lists as objects {0:.., 1:..}, this fixes that.
function safeList(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    return Object.values(val);
}

function isSuperAdminUser() {
    return !!(currentUser && currentUser.superAdmin);
}

async function fetchWithAuth(url, options = {}) {
    let token;
    try {
        token = await auth.currentUser.getIdToken();
    } catch (tokenError) {
        throw new Error('Authentifizierung fehlgeschlagen. Bitte erneut anmelden. (' + (tokenError?.code || tokenError?.message || 'Unbekannter Fehler') + ')');
    }
    const headers = {
        ...(options.headers || {}),
        'Authorization': `Bearer ${token}`
    };
    return fetch(url, { ...options, headers });
}

// ⚡ Bolt: Centralized date helper
function getTodayStr() {
    return new Date(new Date().getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().split('T')[0];
}

// ⚡ Bolt: Replaced Array.reduce with a for loop to eliminate callback execution overhead and reduce CPU time
function calculateTotalPaidLoop(payments) {
    let sum = 0;
    for (let i = 0; i < payments.length; i++) {
        sum += parseFloat(payments[i].amount || 0);
    }
    return sum;
}

// ⚡ Bolt: Helper to normalize and pre-calculate person data for performance
function preprocessPerson(person) {
    if (!person.memberSince) person.memberSince = getTodayStr();
    if (!person.originalMemberSince) person.originalMemberSince = person.memberSince;
    person.payments = safeList(person.payments);

    // ⚡ Bolt: Ensure totalPaid is accurately cached in memory
    person.totalPaid = calculateTotalPaidLoop(person.payments);

    // Pre-process history for faster lookup (avoid Date creation in loops)
    // ⚡ Bolt: Fast string comparison for ISO dates
    person.statusHistory = safeList(person.statusHistory).sort(
        (a, b) => a.startDate.localeCompare(b.startDate)
    );
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}/;
    person.statusHistory.forEach(entry => {
        if (entry.startDate && isoDateRegex.test(entry.startDate)) {
            entry.startTotal = parseInt(entry.startDate.substring(0, 4), 10) * 12 + (parseInt(entry.startDate.substring(5, 7), 10) - 1);
        } else {
            const s = new Date(entry.startDate);
            entry.startTotal = s.getFullYear() * 12 + s.getMonth();
        }

        if (entry.endDate) {
            if (isoDateRegex.test(entry.endDate)) {
                entry.endTotal = parseInt(entry.endDate.substring(0, 4), 10) * 12 + (parseInt(entry.endDate.substring(5, 7), 10) - 1);
            } else {
                const e = new Date(entry.endDate);
                entry.endTotal = e.getFullYear() * 12 + e.getMonth();
            }
        } else {
            entry.endTotal = null;
        }
    });

    // Cache memberSince date object
    person.memberSinceObj = new Date(person.originalMemberSince || person.memberSince);
    return person;
}

// ⚡ Bolt: Helper to find status in sorted history efficiently
function findStatusInHistory(history, idx, currentTotal) {
    let newIdx = idx;
    let status = null;

    // Advance to find relevant entry
    while (newIdx < history.length) {
        const entry = history[newIdx];
        // If endTotal is set and we passed it, move to next
        if (entry.endTotal !== null && currentTotal >= entry.endTotal) {
            newIdx++;
        } else {
            // Found potential candidate (or gap before it)
            break;
        }
    }

    // Check if current candidate covers us
    if (newIdx < history.length) {
        const entry = history[newIdx];
        if (currentTotal >= entry.startTotal) {
            status = entry.status;
        }
    }

    return { status, newIdx };
}

function escapeHtml(text) {
    if (!text) return '';
    // ⚡ Bolt: Single-pass regex for HTML escaping
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

function formatCurrency(amount) {
    const val = parseFloat(amount);
    if (isNaN(val)) return "0,00";
    // ⚡ Bolt: Using persistent NumberFormat for performance
    return numberFormatter.format(val);
}

function validateRequired(ids) {
    let isValid = true;
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el || !el.value.trim()) {
            isValid = false;
            if(el) {
                el.classList.add('input-error');
                el.addEventListener('input', () => el.classList.remove('input-error'), {once: true});
            }
        }
    });
    return isValid;
}

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    checkAuth();

    const today = new Date().toISOString().split('T')[0];
    ['payment-date', 'donation-date', 'expense-date', 'change-status-date', 'new-person-start'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.value = today;
    });
});

window.switchTab = function(tabName, btn) {
    // Some buttons might not pass `btn` or it might not be in a nav, determine scope by string
    const isUserNav = (btn && !!btn.closest('#user-desktop-nav')) || tabName.startsWith('user-');
    const scope = isUserNav ? document.getElementById('user-view') : document.getElementById('admin-view');
    if (!scope) return;

    const navSelector = isUserNav
        ? '#user-desktop-nav [data-tab]'
        : '#admin-desktop-nav [data-tab]';
    const navButtonsDesktop = Array.from(document.querySelectorAll(navSelector));

    let currentIndex = -1;
    let targetIndex = -1;

    // Find indices based on desktop nav
    navButtonsDesktop.forEach((el, index) => {
        if (el.classList.contains('active')) currentIndex = index;
        if (el.dataset.tab === tabName) targetIndex = index;
    });

    // Hide only the tab contents inside the current scope (admin vs user)
    scope.querySelectorAll('.tab-content').forEach(el => {
        el.classList.remove('active', 'slide-in-right', 'slide-in-left');
        if (el.id === 'payment-history' || el.id === 'user-history' || el.id === 'user-requests') el.style.display = 'none';
    });

    // Show the selected tab content only if it belongs to the same scope
    const targetContent = document.getElementById(tabName);
    if (targetContent && scope.contains(targetContent)) {
        targetContent.classList.add('active');

        if (currentIndex !== -1 && targetIndex !== -1 && currentIndex !== targetIndex) {
            if (targetIndex < currentIndex) {
                targetContent.classList.add('slide-in-left');
            } else {
                targetContent.classList.add('slide-in-right');
            }
        } else {
            targetContent.classList.add('slide-in-right'); // fallback
        }

        if (tabName === 'payment-history' || tabName === 'user-history' || tabName === 'user-requests') targetContent.style.display = 'block';
    }

    const appContainer = document.querySelector('.container');
    if (appContainer) {
        const isAiChatActive = !isUserNav && tabName === 'ai-chat';
        appContainer.classList.toggle('ai-chat-active', isAiChatActive);
        if (isAiChatActive) {
            requestAnimationFrame(() => {
                const inputEl = document.getElementById('ai-chat-input');
                adjustAiInputHeight(inputEl);
                const messagesEl = document.getElementById('ai-chat-messages');
                if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
            });
        }
    }

    const allNavSelector = isUserNav
        ? '#user-desktop-nav [data-tab], #user-bottom-nav [data-tab]'
        : '#admin-desktop-nav [data-tab], #admin-bottom-nav [data-tab]';
    const allNavButtons = document.querySelectorAll(allNavSelector);
    allNavButtons.forEach(el => {
        const isActive = el.dataset.tab === tabName;
        if (isActive) {
            el.classList.add('active');
            el.setAttribute('aria-selected', 'true');
        } else {
            el.classList.remove('active');
            el.setAttribute('aria-selected', 'false');
        }
    });

    if (tabName === 'payment-history') {
        window.renderHistoryTab(true);
    }
};

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ⚡ Bolt: Debounce search to prevent synchronous layout thrashing on every keystroke
// Expected impact: Removes main thread blocking during fast typing, especially for large lists
window.filterPeople = debounce(function() {
    const query = document.getElementById('people-search')?.value.toLowerCase() || '';
    const items = document.querySelectorAll('.person-wrapper');
    items.forEach(item => {
        const nameEl = item.querySelector('.person-name');
        if (nameEl && nameEl.textContent.toLowerCase().includes(query)) {
            item.style.display = 'block';
        } else {
            item.style.display = 'none';
        }
    });
}, 300);

window.filterHistory = debounce(function() {
    const query = document.getElementById('history-search')?.value.trim() || '';
    if (transactionSearchQuery !== query) {
        transactionSearchQuery = query;
        window.renderHistoryTab(true);
    }
}, 300);

window.toggleProfileMenu = function() {
    const menu = document.getElementById('profileDropdown');
    const btn = document.querySelector('.profile-btn');
    if (!menu || !btn) return;

    menu.classList.toggle('show');
    btn.setAttribute('aria-expanded', menu.classList.contains('show'));
};

window.openSystemSettingsTab = function() {
    const menu = document.getElementById('profileDropdown');
    if (menu) {
        menu.classList.remove('show');
        document.querySelector('.profile-btn')?.setAttribute('aria-expanded', 'false');
    }
    if (isSuperAdminUser()) {
        switchTab('super-admin-settings', null);
    }
};

window.openSettingsTab = function() {
    // Close the profile menu
    const menu = document.getElementById('profileDropdown');
    if (menu) {
        menu.classList.remove('show');
        document.querySelector('.profile-btn')?.setAttribute('aria-expanded', 'false');
    }

    // Determine current view mode
    const isAdmin = currentUser && currentUser.admin;

    // Find the corresponding nav button and trigger switchTab
    let btn;
    if (isAdmin) {
        btn = document.querySelector('#admin-desktop-nav [data-tab="settings"]') ||
              document.querySelector('#admin-bottom-nav [data-tab="settings"]');
        if(btn) switchTab('settings', btn);
    } else {
        btn = document.querySelector('#user-desktop-nav [data-tab="user-settings"]');
        if(btn) switchTab('user-settings', btn);
    }
};

window.openHomeTab = function() {
    // Close the profile menu
    const menu = document.getElementById('profileDropdown');
    if (menu) {
        menu.classList.remove('show');
        document.querySelector('.profile-btn')?.setAttribute('aria-expanded', 'false');
    }

    // Determine current view mode
    const isAdmin = currentUser && currentUser.admin;

    // Find the corresponding nav button and trigger switchTab
    let btn;
    if (isAdmin) {
        btn = document.querySelector('#admin-desktop-nav [data-tab="overview"]') ||
              document.querySelector('#admin-bottom-nav [data-tab="overview"]');
        if(btn) switchTab('overview', btn);
    } else {
        btn = document.querySelector('#user-desktop-nav [data-tab="user-overview"]');
        if(btn) switchTab('user-overview', btn);
    }
};

// Close profile menu when clicking outside
document.addEventListener('click', (e) => {
    const container = document.querySelector('.profile-menu-container');
    if (container && !container.contains(e.target)) {
        const menu = document.getElementById('profileDropdown');
        if (menu && menu.classList.contains('show')) {
            menu.classList.remove('show');
            document.querySelector('.profile-btn')?.setAttribute('aria-expanded', 'false');
        }
    }
});

window.toggleFab = function() {
    const menu = document.getElementById('fabMenu');
    if (!menu) return;

    menu.classList.toggle('show');
    const isExpanded = menu.classList.contains('show');

    const fabs = document.querySelectorAll('.nav-fab, .desktop-fab, .mobile-fab');
    fabs.forEach(fab => {
        if (isExpanded) {
            fab.classList.add('active');
        } else {
            fab.classList.remove('active');
        }
        fab.setAttribute('aria-expanded', isExpanded);
    });
};

// Web History API tracking for modals
window._modalStack = window._modalStack || [];
window._programmaticBacks = window._programmaticBacks || 0;

window.openModal = (id) => {
    const modal = document.getElementById(id);
    if (!modal) return;

    // Web History API integration
    window._modalStack.push(id);
    history.pushState({ isModal: true, modalId: id }, "");

    // Store current focus on the modal instance itself to handle nesting
    modal._returnFocusTo = document.activeElement;

    // Dynamically increase z-index for nested modals to guarantee correct stacking order
    const baseZIndex = 2000;
    const currentStackDepth = (window._modalStack || []).length;
    modal.style.zIndex = baseZIndex + (currentStackDepth * 10);

    modal.classList.add('show');

    // Removed automatic focus management to prevent soft keyboard from popping up on mobile devices

    // Escape to close
    const handleEsc = (e) => {
        if (e.key === 'Escape') {
            closeModal(id);
        }
    };
    document.addEventListener('keydown', handleEsc);
    modal._escHandler = handleEsc;
};

window.closeModal = (id, fromPopstate = false) => {
    const modal = document.getElementById(id);
    if (!modal) return;

    // Web History API integration
    const stackIndex = window._modalStack ? window._modalStack.indexOf(id) : -1;
    if (stackIndex > -1) {
        window._modalStack.splice(stackIndex, 1);
        if (!fromPopstate) {
            window._programmaticBacks = (window._programmaticBacks || 0) + 1;
            history.back();
            // Fallback if history.back() does not trigger popstate
            setTimeout(() => {
                if (window._programmaticBacks > 0) {
                    window._programmaticBacks--;
                }
            }, 200);
        }
    }

    modal.classList.remove('show');
    modal.style.zIndex = ''; // Reset z-index to default CSS/inline style

    if (modal._escHandler) {
        document.removeEventListener('keydown', modal._escHandler);
        delete modal._escHandler;
    }

    const returnFocus = modal._returnFocusTo;
    if (returnFocus && document.body.contains(returnFocus)) {
        try { returnFocus.focus(); } catch(e){}
    }
    delete modal._returnFocusTo;

    // Re-show the previous modal in the stack if one exists
    if (window._modalStack && window._modalStack.length > 0) {
        const prevModalId = window._modalStack[window._modalStack.length - 1];
        const prevModal = document.getElementById(prevModalId);
        if (prevModal) {
            prevModal.classList.add('show');
        }
    }
};

// Web History API event listener for system back gesture
window.addEventListener('popstate', (e) => {
    if (window._programmaticBacks > 0) {
        window._programmaticBacks--;
        return;
    }

    if (window._modalStack && window._modalStack.length > 0) {
        // Close the top-most modal
        const topModal = window._modalStack[window._modalStack.length - 1];
        closeModal(topModal, true);
    }
});

// Improved Toggle Details
window.toggleDetails = function(id) {
    const drawer = document.getElementById(`drawer-${id}`);
    const header = document.getElementById(`person-item-${id}`);
    const wrapper = header.closest('.person-wrapper');

    const isOpen = drawer.style.maxHeight;

    document.querySelectorAll('.person-details').forEach(el => {
        el.style.maxHeight = null;
        el.classList.remove('active');
    });
    document.querySelectorAll('.person-item').forEach(el => {
        el.classList.remove('active');
        el.setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('.person-wrapper').forEach(el => {
        el.classList.remove('active');
    });

    if (!isOpen) {
        // ⚡ Bolt: Lazy Timeline Injection
        const placeholder = document.getElementById(`timeline-${id}`);
        if (placeholder && !placeholder.dataset.loaded) {
            const person = people.find(p => String(p.id) === String(id));
            if (person) {
                placeholder.innerHTML = generateTimelineHTML(person);
                placeholder.dataset.loaded = "true";
            }
        }

        header.classList.add('active');
        header.setAttribute('aria-expanded', 'true');
        drawer.classList.add('active');
        drawer.style.maxHeight = drawer.scrollHeight + "px";
        if(wrapper) wrapper.classList.add('active');
    }
};

// --- MATHEMATIK & LOGIK (VEREINFACHT & STABIL) ---

/**
 * Gibt den aktuell gültigen Status einer Person zurück (für heute).
 * @param {Object} person - Die Person
 * @returns {string} - Der aktuell gültige Status
 */
function getCurrentStatus(person) {
    const today = new Date();
    return getStatusForMonth(person, today.getFullYear(), today.getMonth());
}

/**
 * Gibt den Status einer Person für einen bestimmten Monat zurück.
 * Berücksichtigt die komplette Statushistorie inkl. rückwirkender/zukünftiger Änderungen.
 * @param {Object} person - Die Person
 * @param {number} year - Das Jahr
 * @param {number} month - Der Monat (0-11)
 * @returns {string|null} - Der Status oder null wenn vor Mitgliedschaft
 */
function getStatusForMonth(person, year, month, sortedHistory = null) {
    // ⚡ Bolt: Fast integer comparison using pre-calculated values
    const currentTotal = year * 12 + month;

    // Check if before membership
    const memberSince = person.memberSinceObj || new Date(person.originalMemberSince || person.memberSince);
    const memberStartTotal = memberSince.getFullYear() * 12 + memberSince.getMonth();

    if (currentTotal < memberStartTotal) {
        return null;
    }

    // Use passed sortedHistory or person.statusHistory (which is now pre-sorted in loadData)
    const history = sortedHistory || person.statusHistory;

    // Fast path: loop through pre-processed history
    if (history && history.length > 0 && history[0].startTotal !== undefined) {
        for (const entry of history) {
            if (currentTotal >= entry.startTotal && (!entry.endTotal || currentTotal < entry.endTotal)) {
                return entry.status;
            }
        }
    } else {
        // Fallback for safety (e.g. if data not normalized)
        const targetDate = new Date(year, month, 15);
        const startOfMemberMonth = new Date(memberSince.getFullYear(), memberSince.getMonth(), 1);

        if (targetDate < startOfMemberMonth) return null;

        const fallbackHistory = safeList(person.statusHistory).slice().sort(
            (a, b) => new Date(a.startDate) - new Date(b.startDate)
        );

        for (const entry of fallbackHistory) {
            const start = new Date(entry.startDate);
            const end = entry.endDate ? new Date(entry.endDate) : null;
            const startMonth = new Date(start.getFullYear(), start.getMonth(), 1);

            if (targetDate >= startMonth && (!end || targetDate < new Date(end.getFullYear(), end.getMonth(), 1))) {
                return entry.status;
            }
        }
    }

    // Kein Treffer in Historie? Aktueller Status gilt
    return person.status;
}

/**
 * Berechnet die Gesamtkosten für alle Monate seit Mitgliedschaft bis zu einem Zieldatum.
 * @param {Object} person - Die Person
 * @param {Date} untilDate - Bis zu welchem Datum berechnen
 * @returns {number} - Gesamtkosten in Euro
 */
function calculateTotalCostUntil(person, untilDate) {
    const memberSince = person.memberSinceObj || new Date(person.originalMemberSince || person.memberSince);
    let totalCost = 0;

    let year = memberSince.getFullYear();
    let month = memberSince.getMonth();

    // History is already sorted in loadData
    const sortedHistory = person.statusHistory;

    // ⚡ Bolt: Optimized linear scan
    let historyIdx = 0;

    // ⚡ Bolt: Pre-calculate target months for faster integer comparison
    const targetTotal = untilDate.getFullYear() * 12 + untilDate.getMonth();

    while ((year * 12 + month) <= targetTotal) {
        const currentTotal = year * 12 + month;

        const { status: historyStatus, newIdx } = findStatusInHistory(sortedHistory, historyIdx, currentTotal);
        historyIdx = newIdx;

        const status = historyStatus || person.status;

        if (status && settings[status]) {
            totalCost += settings[status];
        }

        // Nächster Monat
        month++;
        if (month > 11) {
            month = 0;
            year++;
        }
    }

    return totalCost;
}

/**
 * Berechnet das "Bezahlt bis" Datum basierend auf einfacher Logik:
 * Geht Monat für Monat durch und zieht den jeweiligen Beitrag ab,
 * bis das Guthaben aufgebraucht ist.
 * @param {Object} person - Die Person
 * @returns {Date|null} - Das Datum bis zu dem bezahlt wurde
 */
function calculatePaidUntil(person) {
    return calculatePaymentStatus(person).paidUntil;
}

/**
 * ⚡ Bolt: New function returning detailed payment status including remaining credit.
 * Used to optimize overdue calculation.
 */
function calculatePaymentStatus(person) {
    // ⚡ Bolt: Memoization to avoid costly re-calculation on every render
    if (person._cache_paymentStatus &&
        person._cache_version === settingsVersion &&
        person._cache_totalPaid === person.totalPaid) {
        return person._cache_paymentStatus;
    }

    const totalPaid = person.totalPaid || 0;
    const start = person.memberSinceObj || new Date(person.originalMemberSince || person.memberSince);
    let result;

    // Fall 1: Keine Zahlungen
    if (totalPaid === 0) {
        // Letzter Tag des Vormonats
        result = {
            paidUntil: new Date(start.getFullYear(), start.getMonth(), 0),
            remainingCredit: 0
        };
    } else {
        let remainingCredit = totalPaid;

        let year = start.getFullYear();
        let month = start.getMonth();

        // History is already sorted in loadData
        const sortedHistory = person.statusHistory;

        // Maximal 1200 Monate (100 Jahre) in die Zukunft prüfen
        const maxIterations = 1200;
        let iterations = 0;

        // ⚡ Bolt: Optimized linear scan through history
        let historyIdx = 0;

        while (remainingCredit >= 0 && iterations < maxIterations) {
            // Fast status lookup using pre-calculated total months
            const currentTotal = year * 12 + month;

            const { status: historyStatus, newIdx } = findStatusInHistory(sortedHistory, historyIdx, currentTotal);
            historyIdx = newIdx;

            const status = historyStatus || person.status; // Default/Fallback
            const monthlyRate = status ? (settings[status] || 0) : 0;

            if (monthlyRate > 0) {
                if (remainingCredit >= monthlyRate) {
                    remainingCredit -= monthlyRate;
                } else {
                    // Nicht genug für den vollen Monat - Vormonat ist bezahlt
                    break;
                }
            }

            // Nächster Monat
            month++;
            if (month > 11) {
                month = 0;
                year++;
            }
            iterations++;
        }

        // Der letzte vollständig bezahlte Monat ist der Vormonat
        month--;
        if (month < 0) {
            month = 11;
            year--;
        }

        // Letzter Tag dieses Monats
        result = {
            paidUntil: new Date(year, month + 1, 0),
            remainingCredit: remainingCredit
        };
    }

    // Cache the result
    person._cache_paymentStatus = result;
    person._cache_version = settingsVersion;
    person._cache_totalPaid = totalPaid;

    return result;
}

/**
 * ⚡ Bolt: Helper to calculate cost for a range. Used by optimized overdue calculation.
 */
function calculateCostRange(person, startDate, endDate) {
    let totalCost = 0;
    let year = startDate.getFullYear();
    let month = startDate.getMonth();
    const sortedHistory = person.statusHistory;

    // Safety break
    let limit = 0;

    // ⚡ Bolt: Optimized linear scan
    let historyIdx = 0;

    // ⚡ Bolt: Pre-calculate target months for faster integer comparison
    const targetTotal = endDate.getFullYear() * 12 + endDate.getMonth();

    while ((year * 12 + month) <= targetTotal && limit < 1200) {
        const currentTotal = year * 12 + month;

        const { status: historyStatus, newIdx } = findStatusInHistory(sortedHistory, historyIdx, currentTotal);
        historyIdx = newIdx;

        const status = historyStatus || person.status;

        if (status && settings[status]) {
            totalCost += settings[status];
        }
        month++;
        if (month > 11) { month = 0; year++; }
        limit++;
    }
    return totalCost;
}

/**
 * Berechnet den verbleibenden Zeitraum und Status für eine Person.
 * @param {Object} person - Die Person
 * @returns {Object} - { text, isOverdue, isSoonDue }
 */
function calculateTimeRemaining(person, preCalculatedPaidUntil, todayStrArg = null, preCalcCredit = null) {
    // START CHECK
    const standingOrders = safeList(person.standingOrders);
    const todayStr = todayStrArg || getTodayStr();

    let totalSOAmount = 0;
    const activeSOs = standingOrders.filter(so => {
         if (so.startDate > todayStr) return false;
         if (so.endDate && so.endDate < todayStr) return false;
         return true;
    });
    activeSOs.forEach(so => totalSOAmount += parseFloat(so.amount || 0));
    const hasActiveSO = activeSOs.length > 0;

    const paidUntil = preCalculatedPaidUntil !== undefined ? preCalculatedPaidUntil : calculatePaidUntil(person);
    if (!paidUntil) {
        if (hasActiveSO) {
             return { text: 'Keine Zahlungen', isOverdue: true, isSoonDue: false, isActiveStandingOrder: true };
        }
        return { text: 'Keine Zahlungen', isOverdue: true, isSoonDue: false };
    }

    const today = new Date();
    // ⚡ Bolt: Calculate monthsDiff using integer math
    const currentTotal = today.getFullYear() * 12 + today.getMonth();
    const paidTotal = paidUntil.getFullYear() * 12 + paidUntil.getMonth();
    const monthsDiff = paidTotal - currentTotal;

    // CALCULATE TRUE MISSING AMOUNT FOR CURRENT MONTH
    const targetDate = new Date(today.getFullYear(), today.getMonth() + 1, 0); // End of current month

    const startCalc = new Date(paidUntil);
    startCalc.setDate(1);
    startCalc.setMonth(startCalc.getMonth() + 1);

    let trueMissingAmount = 0;
    if (startCalc <= targetDate) {
        const missingCost = calculateCostRange(person, startCalc, targetDate);

        let creditToUse = preCalcCredit;
        if (creditToUse === null || creditToUse === undefined) {
             const paymentStatus = calculatePaymentStatus(person);
             creditToUse = paymentStatus.remainingCredit;
        }

        trueMissingAmount = missingCost - (creditToUse || 0);
        if (trueMissingAmount < 0) trueMissingAmount = 0;
    }

    if (monthsDiff < 0) {
        const overdueMonths = Math.abs(monthsDiff);

        // Only allow standing order buffer for the current month (monthsDiff === -1)
        if (hasActiveSO && overdueMonths === 1) {
            // Check if the standing order covers the missing amount
            // Since the standing order will run this month, it will contribute `totalSOAmount`
            // If trueMissingAmount <= totalSOAmount, then after SO executes, they will owe 0.
            if (trueMissingAmount <= totalSOAmount) {
                return {
                    text: 'Alles in Ordnung',
                    isOverdue: false,
                    isSoonDue: true, // Mark them as soon due since the standing order is expected this month
                    isActiveStandingOrder: true
                };
            } else {
                return {
                    text: 'Zahlung überfällig',
                    isOverdue: true,
                    isSoonDue: false,
                    isActiveStandingOrder: true
                };
            }
        }

        return {
            text: `${overdueMonths} Monat${overdueMonths !== 1 ? 'e' : ''} überfällig`,
            isOverdue: true,
            isSoonDue: false
        };
    }

    if (hasActiveSO) {
        return {
            text: 'Alles in Ordnung',
            isOverdue: false,
            isSoonDue: false,
            isActiveStandingOrder: true
        };
    }

    if (monthsDiff === 0) {
        return { text: 'läuft diesen Monat ab', isOverdue: false, isSoonDue: true };
    } else if (monthsDiff === 1) {
        return { text: 'läuft nächsten Monat ab', isOverdue: false, isSoonDue: true };
    } else {
        return { text: `noch ${monthsDiff} Monat${monthsDiff !== 1 ? 'e' : ''}`, isOverdue: false, isSoonDue: false };
    }
}

/**
 * Berechnet den fehlenden Betrag in Euro bis zum Ende des aktuellen Monats.
 * @param {Object} person - Die Person
 * @param {Date} [preCalcPaidUntil] - Optional: Vorberechnetes "Bezahlt bis" Datum
 * @param {number} [preCalcCredit] - Optional: Vorberechnetes Restguthaben
 * @returns {number} - Fehlender Betrag (0 wenn ausgeglichen oder Guthaben)
 */
function isPaymentInCurrentMonth(paymentDate, today) {
    if (!paymentDate) return false;
    const parsed = new Date(paymentDate);
    if (Number.isNaN(parsed.getTime())) return false;
    return parsed.getFullYear() === today.getFullYear() && parsed.getMonth() === today.getMonth();
}

function hasStandingOrderPaidThisMonth(person, standingOrder, today) {
    const payments = safeList(person.payments);
    const soAmount = parseFloat(standingOrder.amount || 0);
    const soIdPrefix = standingOrder.id ? `auto_${standingOrder.id}_` : null;

    return payments.some((payment) => {
        if (!isPaymentInCurrentMonth(payment.date, today)) {
            return false;
        }

        if (soIdPrefix && typeof payment.id === 'string' && payment.id.startsWith(soIdPrefix)) {
            return true;
        }

        const isAutoLike = payment.isAuto === true || String(payment.description || '').includes('(Auto)');
        const amountMatches = Math.abs(parseFloat(payment.amount || 0) - soAmount) < 0.0001;
        return isAutoLike && amountMatches;
    });
}

/**
 * Berechnet den fehlenden Betrag in Euro bis zum Ende des aktuellen Monats.
 * @param {Object} person - Die Person
 * @param {Date} [preCalcPaidUntil] - Optional: Vorberechnetes "Bezahlt bis" Datum
 * @param {number} [preCalcCredit] - Optional: Vorberechnetes Restguthaben
 * @returns {number} - Fehlender Betrag (0 wenn ausgeglichen oder Guthaben)
 */
function calculateOverdueAmount(person, preCalcPaidUntil, preCalcCredit, todayStrArg = null) {
    const today = new Date();

    // Check for active standing orders
    const standingOrders = safeList(person.standingOrders);
    const todayStr = todayStrArg || getTodayStr();

    let anticipatedSOAmount = 0;
    const activeSOs = standingOrders.filter(so => {
         if (so.startDate > todayStr) return false;
         if (so.endDate && so.endDate < todayStr) return false;
         return true;
    });

    activeSOs.forEach(so => {
        // Only consider it an anticipated buffer if it hasn't been executed yet this month
        if (!hasStandingOrderPaidThisMonth(person, so, today)) {
            anticipatedSOAmount += parseFloat(so.amount || 0);
        }
    });
    const hasActiveSO = activeSOs.length > 0;

    // ALWAYS calculate up to the end of the current month
    const targetDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    let finalMissing = 0;

    // ⚡ Bolt: Optimized path avoiding full history iteration
    if (preCalcPaidUntil) {
        // Start calculation from the month AFTER paidUntil
        const startCalc = new Date(preCalcPaidUntil);
        startCalc.setDate(1);
        startCalc.setMonth(startCalc.getMonth() + 1);

        if (startCalc <= targetDate) {
             const missingCost = calculateCostRange(person, startCalc, targetDate);
             const credit = preCalcCredit || 0;
             finalMissing = missingCost - credit;
        }
    } else {
        const totalCost = calculateTotalCostUntil(person, targetDate);
        const totalPaid = person.totalPaid || 0;
        finalMissing = totalCost - totalPaid;
    }

    if (finalMissing < 0) finalMissing = 0;

    // If the user has active standing orders scheduled for this month,
    // we subtract that anticipated payment from the total missing amount
    // so it doesn't show as an overdue sum yet.
    if (hasActiveSO && finalMissing > 0) {
        finalMissing = finalMissing - anticipatedSOAmount;
    }

    return finalMissing > 0 ? finalMissing : 0;
}

/**
 * Generiert HTML für die Statushistorie einer Person.
 * @param {Object} person - Die Person
 * @returns {string} - HTML String
 */
function generateStatusHistoryHTML(person) {
    // ⚡ Bolt: Fast string comparison for ISO dates
    const history = safeList(person.statusHistory).slice().sort(
        (a, b) => b.startDate.localeCompare(a.startDate)
    );

    // Aktueller Status hinzufügen (offen)
    const currentStatusStart = history.length > 0
        ? history[0].endDate
        : (person.originalMemberSince || person.memberSince);

    const statusLabels = {
        'vollverdiener': '💼 Vollverdiener',
        'geringverdiener': '📉 Geringverdiener',
        'keinverdiener': '🎓 Keinverdiener',
        'pausiert': '⏸️ Pausiert'
    };

    let html = `
        <div class="trans-item" style="background: rgba(6, 182, 212, 0.05); border: 1px solid rgba(6, 182, 212, 0.2);">
            <div class="trans-left">
                <span style="font-weight:600;">${escapeHtml(statusLabels[person.status] || person.status)}</span>
                <div class="trans-meta">Seit ${formatDateFast(currentStatusStart)} • Aktuell</div>
            </div>
            <div style="font-size:0.75rem; color:var(--success); font-weight:600;">AKTIV</div>
        </div>
    `;

    if (history.length === 0) {
        return html;
    }

    html += history.map(entry => {
        const start = formatDateFast(entry.startDate);
        const end = entry.endDate ? formatDateFast(entry.endDate) : 'Offen';
        const rate = settings[entry.status] || 0;

        return `
            <div class="trans-item">
                <div class="trans-left">
                    <span>${escapeHtml(statusLabels[entry.status] || entry.status)}</span>
                    <div class="trans-meta">${start} – ${end}</div>
                </div>
                <div style="font-size:0.8rem; color:var(--text-secondary);">${formatCurrency(rate)}€/Monat</div>
            </div>
        `;
    }).join('');

    return html;
}

// --- ENDE MATHEMATIK & LOGIK ---

function checkAndExecuteStandingOrders(person) {
    if (!person.standingOrders || !Array.isArray(person.standingOrders) || person.standingOrders.length === 0) return null;

    let modified = false;
    const payments = safeList(person.payments);
    const standingOrders = safeList(person.standingOrders);
    const today = new Date();
    today.setHours(23,59,59,999); // Use end of day to avoid timezone lag (UTC vs Local)

    // ⚡ Bolt: Build a Set for O(1) payment ID lookups, avoiding O(N) array scans inside the loop
    const existingPaymentIds = new Set(payments.map(p => p.id));
    const updatedStandingOrders = [];

    for (const so of standingOrders) {
        let soModified = false;
        let currentSO = { ...so };
        const startDate = new Date(currentSO.startDate);
        const dayOfMonth = startDate.getDate();
        let lastAuto = currentSO.lastAutoPayment ? new Date(currentSO.lastAutoPayment) : null;

        // Determine limit date: min(today, endDate)
        let limitDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
        let isExpired = false;

        if (currentSO.endDate) {
            const end = new Date(currentSO.endDate);
            end.setHours(23, 59, 59, 999);

            // Constraint 1: Still respect currentSO.endDate.
            if (end < limitDate) {
                limitDate = end;
            }

            if (end < today) {
                isExpired = true;
            }
        }

        // Determine where to start checking
        let nextDueDate;
        if (!lastAuto) {
            nextDueDate = new Date(startDate);
        } else {
            nextDueDate = new Date(lastAuto);
            nextDueDate.setDate(1);
            nextDueDate.setMonth(nextDueDate.getMonth() + 1);
            const maxDays = new Date(nextDueDate.getFullYear(), nextDueDate.getMonth() + 1, 0).getDate();
            nextDueDate.setDate(Math.min(dayOfMonth, maxDays));
        }

        // Loop until limitDate
        // Safety break to prevent infinite loops if dates are messed up
        let safety = 0;
        while (nextDueDate <= limitDate && safety < 1200) {
            const dateStr = nextDueDate.toISOString().split('T')[0];
            const paymentId = `auto_${currentSO.id}_${dateStr}`;

            // ⚡ Bolt: O(1) lookup instead of O(N) payments.some(...)
            if (!existingPaymentIds.has(paymentId)) {
                payments.push({
                    id: paymentId,
                    amount: parseFloat(currentSO.amount),
                    date: dateStr,
                    description: (currentSO.note || 'Dauerauftrag') + ' (Auto)',
                    isAuto: true
                });
                existingPaymentIds.add(paymentId); // Update Set with new ID
                modified = true;
                soModified = true;
            }

            // Move pointer forward
            lastAuto = new Date(nextDueDate);

            nextDueDate.setDate(1);
            nextDueDate.setMonth(nextDueDate.getMonth() + 1);
            const maxDays = new Date(nextDueDate.getFullYear(), nextDueDate.getMonth() + 1, 0).getDate();
            nextDueDate.setDate(Math.min(dayOfMonth, maxDays));
            safety++;
        }

        if (soModified && lastAuto) {
            currentSO.lastAutoPayment = lastAuto.toISOString().split('T')[0];
        }

        if (isExpired) {
            // Remove from list if expired
            modified = true;
        } else {
            updatedStandingOrders.push(currentSO);
            if (soModified) modified = true;
        }
    }

    if (modified) {
        return { ...person, payments, standingOrders: updatedStandingOrders };
    }
    return null;
}

let requests = [];

async function loadData(silent = false) {
    // Ladebildschirm anzeigen
    const loader = document.getElementById('loading-overlay');
    if(loader && !silent) loader.style.display = 'flex';

    const dbRef = ref(db);

    try {
        // Non-admin: fetch only what is needed for their view (people + settings + their requests)
    if (currentUser && !currentUser.admin) {
        advancedConfigLoaded = false;
        advancedConfigAppName = null;
        // 1. Fetch Settings
        const sSnap = await get(child(dbRef, 'settings'));
        if (sSnap.exists()) {
            settings = sSnap.val();
            settingsVersion++;
        }

        // 2. Fetch User's Person Entry (Securely with Fallback)
        const peopleRef = child(dbRef, 'people');
        let peopleList = [];

        try {
            // Try by UID first (Requires Index)
            let q = query(peopleRef, orderByChild('uid'), equalTo(currentUser.uid));
            let pSnap = await get(q);

            if (pSnap.exists()) {
                peopleList = safeList(pSnap.val());
            } else {
                // Fallback: Try by Name (Requires Index)
                const fullName = `${currentUser.firstName} ${currentUser.lastName}`;
                q = query(peopleRef, orderByChild('name'), equalTo(fullName));
                pSnap = await get(q);

                if (pSnap.exists()) {
                    const val = pSnap.val();
                    // Link the first match to this UID
                    const key = Object.keys(val)[0];
                    if (key) {
                        await update(child(peopleRef, key), { uid: currentUser.uid });
                        const p = val[key];
                        p.uid = currentUser.uid;
                        peopleList = [p];
                    }
                }
            }
        } catch (queryErr) {
            console.warn("Index missing, falling back to client-side filtering:", queryErr);
            // Fallback: Fetch all and filter client-side (slower but works without index)
            const pSnap = await get(peopleRef);
            const allPeople = safeList(pSnap.val());
            const fullName = `${currentUser.firstName} ${currentUser.lastName}`.toLowerCase();

            // Find by UID or Name
            peopleList = allPeople.filter(p => p.uid === currentUser.uid || p.name.toLowerCase() === fullName);

            // Auto-link if found by name but no UID
            if (peopleList.length > 0) {
                const p = peopleList[0];
                if (!p.uid && p.name.toLowerCase() === fullName) {
                    p.uid = currentUser.uid;
                    // We need the key to update. Assuming 'id' is the key or we need to find it.
                    // In this app structure, people is an array or object.
                    // If it's an object keyed by record id, we need the key.
                    // safeList loses keys if not careful, but here we just need to update the object in memory for now.
                    // To persist the link, we would need to know the key.
                    // Let's try to find the key from the snapshot if possible.
                    if(pSnap.exists()) {
                        const val = pSnap.val();
                        const key = Object.keys(val).find(k => val[k].id === p.id);
                        if(key) {
                            update(child(peopleRef, key), { uid: currentUser.uid });
                        }
                    }
                }
            }
        }
        people = peopleList.filter(p => !p.isDeleted);

        // 3. Fetch User's Requests
        const requestsRef = child(dbRef, 'requests');
        let rSnap;
        try {
            const reqQuery = query(requestsRef, orderByChild('userId'), equalTo(currentUser.uid));
            rSnap = await get(reqQuery);
        } catch (reqErr) {
            console.warn("Request index missing, fetching all requests:", reqErr);
            rSnap = await get(requestsRef);
        }

        const allRequests = safeList(rSnap.val());
        // If we fell back to all requests, filter them now
        requests = allRequests.filter(r => r.userId === currentUser.uid);

        // UI toggles
        document.getElementById('admin-view').style.display = 'none';
        document.getElementById('user-view').style.display = 'block';
        const adminDesktopNav = document.getElementById('admin-desktop-nav');
        const userDesktopNav = document.getElementById('user-desktop-nav');
        if (adminDesktopNav) adminDesktopNav.style.display = 'none';
        if (userDesktopNav) userDesktopNav.style.display = '';

        // Hide desktop FAB for non-admins
        const desktopFab = document.getElementById('desktop-fab');
        if(desktopFab) desktopFab.style.display = 'none';

        const adminBottomNav = document.getElementById('admin-bottom-nav');
        if(adminBottomNav) adminBottomNav.style.display = 'none';
        const userBottomNav = document.getElementById('user-bottom-nav');
        if(userBottomNav) userBottomNav.style.display = 'flex';

        document.getElementById('settings').style.display = 'none';

        const sysSettingsBtn = document.getElementById('profile-sys-settings-btn');
        if (sysSettingsBtn) sysSettingsBtn.style.display = 'none';

        // Populate User View basic info
        document.getElementById('user-name-display').innerText = `${currentUser.firstName} ${currentUser.lastName}`;
        document.getElementById('user-email-display').innerText = currentUser.email;

    } else {
        advancedConfigLoaded = false;
        advancedConfigAppName = null;
        // Admin: fetch full dataset
        const [pData, sData, cData, rData, uData] = await Promise.all([
            apiGet('people').catch(() => null),
            apiGet('settings').catch(() => null),
            apiGet('system/inviteCode').catch(() => null),
            apiGet('requests').catch(() => null),
            apiGet('users').catch(() => null)
        ]);

        people = safeList(pData).filter(p => !p.isDeleted);
        // We no longer need to load all donations and expenses on startup for the Admin!
        // The stats endpoint and transaction pagination handle this data now.
        donations = [];
        expenses = [];
        requests = safeList(rData);

        if (sData) {
            settings = sData;
            settingsVersion++;
        }
        users = uData
            ? Object.entries(uData).map(([uid, data]) => ({...data, uid}))
            : [];

        // Show Invite Code
        const code = cData ? cData : '123456';
        const codeInput = document.getElementById('admin-invite-code');
        if(codeInput) codeInput.value = code;

        // UI toggles
        document.getElementById('admin-view').style.display = 'block';
        document.getElementById('user-view').style.display = 'none';
        const adminDesktopNav = document.getElementById('admin-desktop-nav');
        const userDesktopNav = document.getElementById('user-desktop-nav');
        if (adminDesktopNav) adminDesktopNav.style.display = '';
        if (userDesktopNav) userDesktopNav.style.display = 'none';

        // Show desktop FAB for admins (CSS handles layout)
        const desktopFab = document.getElementById('desktop-fab');
        if(desktopFab) desktopFab.style.display = '';

        const adminBottomNav = document.getElementById('admin-bottom-nav');
        if(adminBottomNav) adminBottomNav.style.display = 'flex';
        const userBottomNav = document.getElementById('user-bottom-nav');
        if(userBottomNav) userBottomNav.style.display = 'none';

        document.getElementById('settings').style.display = '';

        // Fetch AI enabled state for all admins to show/hide AI nav button
        fetchWithAuth(`${config.apiBaseUrl}/admin/ai-status`).then(r => {
            if (r.ok) return r.json();
        }).then(data => {
            if (data) {
                aiEnabled = !!data.enabled;
                updateAiNavVisibility();
            }
        }).catch(() => {});
    }

    // Normalize people data
    people.forEach(person => preprocessPerson(person));

    // Check standing orders (Admin only to prevent conflicts)
    if (currentUser && currentUser.admin) {
        const updates = [];
        people.forEach(person => {
            const result = checkAndExecuteStandingOrders(person);
            if (result) {
                const newTotal = calculateTotalPaidLoop(safeList(result.payments));
                // Update in DB
                updates.push(update(ref(db, 'people/' + person.id), {
                    payments: result.payments,
                    standingOrders: result.standingOrders,
                    totalPaid: newTotal
                }));
                // Update in memory
                Object.assign(person, result, { totalPaid: newTotal });
            }
        });
        if (updates.length > 0) await Promise.all(updates);
    }

    if (!silent) {
        await renderAll();
    } else {
        await updateActiveViews();
    }
    } catch (err) {
        console.error("Ladefehler:", err);
        alert("Fehler beim Laden der Daten. Bitte Seite neu laden.");
    } finally {
        // Ladebildschirm ausblenden
        if(loader && !silent) loader.style.display = 'none';
    }
}

async function updateActiveViews() {
    if (currentUser && !currentUser.admin) {
        renderUserView();
    } else {
        renderPeople();
        await renderStats();
        renderAdminRequests();
        renderUnlinkedUsers();
        if (typeof isSuperAdminUser === 'function' && isSuperAdminUser()) {
            renderSuperAdminUserManagement();
        }
    }
}

async function renderAll() {
    if (currentUser && !currentUser.admin) {
        renderUserView();
    } else {
        renderPeople();
        await renderStats();
        renderAdminRequests();
        renderUnlinkedUsers();
        document.getElementById('rate-vollverdiener').value = settings.vollverdiener;
        document.getElementById('rate-geringverdiener').value = settings.geringverdiener;
        document.getElementById('rate-keinverdiener').value = settings.keinverdiener;
        document.getElementById('report-start-date').value = settings.reportStartDate || '';

        if (currentUser) {
            document.getElementById('admin-email-notifications').checked = !!currentUser.emailNotifications;
        }
        await renderSuperAdminTools();
    }
}

async function renderSuperAdminTools() {
    const card = document.getElementById('card-super-admin');
    const sysSettingsBtn = document.getElementById('profile-sys-settings-btn');
    const sysNavBtnDesktop = document.getElementById('admin-sys-nav-btn-desktop');
    const sysNavBtnBottom = document.getElementById('admin-sys-nav-btn');
    const isAdmin = !!(currentUser && currentUser.admin);

    if (sysNavBtnDesktop) sysNavBtnDesktop.style.display = isAdmin ? 'block' : 'none';
    if (sysNavBtnBottom) sysNavBtnBottom.style.display = isAdmin ? 'flex' : 'none';

    if (!isSuperAdminUser()) {
        if (card) card.style.display = 'none';
        if (sysSettingsBtn) sysSettingsBtn.style.display = 'none';
        return;
    }

    if (card) card.style.display = '';
    if (sysSettingsBtn) sysSettingsBtn.style.display = '';

    renderSuperAdminUserManagement();
    await renderSuperAdminPaymentEditor();
    if (!advancedConfigLoaded) {
        loadAdvancedSystemConfig();
    }
}

function renderAdminRequests() {
    const pending = requests.filter(r => r.status === 'pending');
    const target = document.getElementById('admin-requests-inline');
    if (!target) return;

    if (pending.length === 0) {
        target.innerHTML = '';
        return;
    }

    const grouped = pending.reduce((acc, req) => {
        const key = req.personName || 'Unbekannt';
        if (!acc[key]) acc[key] = [];
        acc[key].push(req);
        return acc;
    }, {});

    const renderReq = (req) => {
        let typeLabel = '';
        let typeIcon = '';
        let details = '';

        if (req.type === 'payment') {
            typeLabel = 'Zahlung';
            typeIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>';
            details = `${formatCurrency(req.data.amount)} € am ${formatDateFast(req.data.date)}`;
            if (req.data.note) details += `<br><small style="color: var(--text-secondary);"><span style="opacity: 0.7;">"</span>${escapeHtml(req.data.note)}<span style="opacity: 0.7;">"</span></small>`;
        } else if (req.type === 'status') {
            typeLabel = 'Statusänderung';
            typeIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
            details = `Neu: <strong>${escapeHtml(req.data.newStatus)}</strong> ab ${formatDateFast(req.data.date)}`;
        } else if (req.type === 'expense') {
            typeLabel = 'Ausgabe';
            typeIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 14h-8"/><path d="M16 18h-8"/><path d="M16 10h-8"/></svg>';
            details = `${formatCurrency(req.data.amount)} € für "${escapeHtml(req.data.description)}" am ${formatDateFast(req.data.date)}`;
            if (req.data.receipt) {
                const safeReceipt = escapeHtml(req.data.receipt);
                const safeId = escapeHtml(req.id);
                details += `<div id="receipt-container-${safeId}" style="margin-top:10px;">
                    <button class="btn btn-small" style="background: transparent; border: 1px solid var(--border); color: var(--text); display: flex; align-items: center; gap: 6px;" data-receipt="${safeReceipt}" data-id="${safeId}" onclick="viewRequestReceipt(this.dataset.receipt, 'receipt-container-' + this.dataset.id)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                        Beleg anzeigen
                    </button>
                </div>`;
            }
        } else if (req.type === 'standing_order') {
            typeLabel = 'Dauerauftrag';
            typeIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';
            details = `${formatCurrency(req.data.amount)} € / Monat<br>Start: ${formatDateFast(req.data.date)}`;
            if (req.data.note) details += `<br><small style="color: var(--text-secondary);"><span style="opacity: 0.7;">"</span>${escapeHtml(req.data.note)}<span style="opacity: 0.7;">"</span></small>`;
        }

        return `
            <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 16px; margin-bottom: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                <div style="display:flex; justify-content:space-between; gap:10px; margin-bottom:12px; align-items:center;">
                    <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--text);">
                        ${typeIcon}
                        <span>${typeLabel}</span>
                    </div>
                    <span style="font-size:0.75rem; color:var(--text-secondary); white-space:nowrap; background: var(--surface-alt); padding: 4px 8px; border-radius: 12px;">${dateTimeFormatter.format(new Date(req.timestamp))}</span>
                </div>
                <div style="margin-bottom:16px; font-size: 0.95rem; color: var(--text); line-height: 1.5;">${details}</div>
                <div style="display:flex; gap:10px;">
                    <button class="btn btn-primary btn-small" style="flex: 1; display: flex; justify-content: center; align-items: center; gap: 6px; border-radius: 12px; padding: 8px 0;" data-id="${escapeHtml(req.id)}" onclick="approveRequest(this.dataset.id)">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                        Genehmigen
                    </button>
                    <button class="btn btn-small" style="flex: 1; display: flex; justify-content: center; align-items: center; gap: 6px; background: transparent; color: var(--text-secondary); border: 1px solid var(--border); border-radius: 12px; padding: 8px 0;" data-id="${escapeHtml(req.id)}" onclick="rejectRequest(this.dataset.id)">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                        Ablehnen
                    </button>
                </div>
            </div>
        `;
    };

    const groupBlocks = Object.entries(grouped)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([personName, items]) => {
            const sorted = items.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            return `
                <div style="margin-top: 16px;">
                    <div style="font-weight: 600; margin-bottom: 10px; color: var(--text); font-size: 0.95rem; display: flex; align-items: center; gap: 8px;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--secondary);"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        ${escapeHtml(personName)}
                    </div>
                    ${sorted.map(renderReq).join('')}
                </div>
            `;
        })
        .join('');

    target.innerHTML = `
        <div class="card" style="margin-bottom: 20px;">
            <div class="card-header" style="display: flex; align-items: center; gap: 8px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.9rem; color: var(--text-secondary);">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                Offene Anfragen (${pending.length})
            </div>
            <div class="card-body" style="padding-top: 10px;">${groupBlocks}</div>
        </div>
    `;
}

function renderUnlinkedUsers() {
    const target = document.getElementById('unlinkedUsers');
    if (!target) return;

    // ⚡ Bolt: Use a Set for O(1) lookups instead of O(N*M) nested loops
    const linkedUids = new Set(people.filter(p => p.uid).map(p => p.uid));
    const unlinked = users.filter(u => !linkedUids.has(u.uid));
    const availablePeople = people.filter(p => !p.uid);

    if (unlinked.length === 0) {
        target.innerHTML = '';
        return;
    }

    const options = availablePeople.map(p => `<option value="${p.id}">${p.name}</option>`).join('');

    const rows = unlinked.map(u => {
        return `
            <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                <div style="flex:1; min-width:200px;">
                    <div style="font-weight:700;">${escapeHtml(u.firstName || '?')} ${escapeHtml(u.lastName || '')}</div>
                    <div style="font-size:0.85rem; color:var(--text-secondary);">${escapeHtml(u.email || '')}</div>
                </div>
                <select id="link-select-${u.uid}" class="form-select" style="flex:1; min-width:220px;">
                    <option value="">Person auswählen</option>
                    ${options}
                </select>
                <button class="btn btn-primary btn-small" style="width:auto;" data-uid="${escapeHtml(u.uid)}" onclick="assignUserToPerson(this.dataset.uid)">Zuordnen</button>
            </div>
        `;
    }).join('');

    target.innerHTML = `
        <div class="card" style="margin-bottom:20px;">
            <div class="card-header">🧩 Nicht zugeordnete Benutzer (${unlinked.length})</div>
            <div class="card-body">
                ${availablePeople.length === 0 ? '<div style="color:var(--text-secondary);">Keine freien Personen ohne Zuordnung vorhanden.</div>' : rows}
            </div>
        </div>
    `;
}

window.assignUserToPerson = async (uid) => {
    const select = document.getElementById(`link-select-${uid}`);
    if (!select) return;
    const personId = select.value;
    if (!personId) { alert('Bitte eine Person auswählen.'); return; }

    const person = people.find(p => String(p.id) === String(personId));
    if (!person) { alert('Person nicht gefunden.'); return; }

    try {
        await update(ref(db, 'people/' + personId), { uid });
        person.uid = uid;
        showToast('Zuordnung gespeichert');
        renderUnlinkedUsers();
        renderPeople();
    } catch (err) {
        console.error('Fehler beim Zuordnen:', err);
        alert('Zuordnung fehlgeschlagen. Bitte erneut versuchen.');
    }
};

function renderSuperAdminUserManagement() {
    const target = document.getElementById('super-admin-user-management');
    if (!target || !isSuperAdminUser()) return;

    if (!users || users.length === 0) {
        target.innerHTML = '<div style="color:var(--text-secondary);">Keine Benutzer gefunden.</div>';
        return;
    }

    superAdminUserRows = users
        .slice()
        .sort((a, b) => `${a.firstName || ''} ${a.lastName || ''}`.localeCompare(`${b.firstName || ''} ${b.lastName || ''}`));

    const rows = superAdminUserRows
        .map((u, index) => {
            const fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Unbekannt';
            const isSuper = u.superAdmin === true;
            return `
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; padding:10px; border:1px solid var(--border); border-radius:10px;">
                    <div style="flex:1; min-width: 150px;">
                        <div style="font-weight:700;">${escapeHtml(fullName)} ${isSuper ? '👑' : ''}</div>
                        <div style="font-size:0.85rem; color:var(--text-secondary);">${escapeHtml(u.email || '')}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <label class="switch" style="flex-shrink: 0;">
                            <input type="checkbox" ${u.admin ? 'checked' : ''} ${isSuper ? 'disabled' : ''} onchange="setSupervisorAdminByIndex(${index}, this.checked)">
                            <span class="slider"></span>
                        </label>
                        <span style="font-weight:600; font-size: 0.9rem;">Supervisor Admin</span>
                    </div>
                </div>
            `;
        }).join('');

    target.innerHTML = rows;
}

async function renderSuperAdminPaymentEditor() {
    if (document.getElementById('payment-history')?.classList.contains('active')) {
        renderHistoryTab(true);
    }
}

window.setSupervisorAdmin = async (uid, isAdmin) => {
    if (!isSuperAdminUser()) return;
    try {
        const response = await fetchWithAuth(`${config.apiBaseUrl}/admin/users/${uid}/admin`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin: !!isAdmin })
        });
        if (!response.ok) {
            const msg = await response.text();
            throw new Error(msg || 'Speichern fehlgeschlagen');
        }
        const localUser = users.find(u => u.uid === uid);
        if (localUser) localUser.admin = !!isAdmin;
        renderSuperAdminUserManagement();
        showToast('Benutzerrechte gespeichert');
    } catch (err) {
        console.error('Fehler beim Speichern der Rolle:', err);
        showToast('Benutzerrechte konnten nicht gespeichert werden', 'error');
        loadData();
    }
};

window.setSupervisorAdminByIndex = async (index, isAdmin) => {
    const user = superAdminUserRows[index];
    if (!user || !user.uid) return;
    await window.setSupervisorAdmin(user.uid, isAdmin);
};

window.editRecordedPayment = async (personId, paymentId, paymentIndex, personName = null, type = 'payment', paymentObj = null) => {
    if (!(currentUser && currentUser.admin)) return;

    let payment = paymentObj;
    let targetIndex = paymentIndex;

    if (type === 'payment') {
        const person = people.find(p => String(p.id) === String(personId));
        if (person) {
            const payments = safeList(person.payments);
            const idx = payments.findIndex((p, i) => String(p.id ?? `idx-${i}`) === String(paymentId));
            targetIndex = idx >= 0 ? idx : paymentIndex;
            payment = payments[targetIndex] || paymentObj; // Resilient fallback
        } else {
            // Fallback for logically deleted/archived members who are not in the active people list
            targetIndex = paymentIndex;
            payment = paymentObj;
        }
    }

    if (!payment) {
        console.error("editRecordedPayment: No payment structure resolved.", { personId, paymentId, paymentIndex, type, paymentObj });
        return;
    }

    currentEditedPayment = { personId, targetIndex, type, paymentId };

    let titlePrefix = '';
    if (type === 'donation') titlePrefix = '[Spende] ';
    else if (type === 'expense') titlePrefix = '[Ausgabe] ';

    document.getElementById('edit-payment-person').textContent = titlePrefix + (personName || 'Unbekannt');
    document.getElementById('edit-payment-amount').value = String(payment.amount ?? '');
    document.getElementById('edit-payment-date').value = payment.date || '';

    const descEl = document.getElementById('edit-payment-desc');
    if (descEl) descEl.value = payment.description || '';

    const issuerGroup = document.getElementById('edit-payment-issuer-group');
    const issuerEl = document.getElementById('edit-payment-issuer');

    if (type === 'expense') {
        if (issuerGroup) issuerGroup.style.display = 'block';
        if (issuerEl) issuerEl.value = payment.issuer || payment.name || '';
    } else {
        if (issuerGroup) issuerGroup.style.display = 'none';
        if (issuerEl) issuerEl.value = '';
    }

    openModal('edit-payment-modal');
};

window.editRecordedPaymentByIndex = function(index) {
    if (!cachedTransactions || !cachedTransactions[index]) {
        console.error("editRecordedPaymentByIndex: Transaction not found at index", index);
        return;
    }
    const t = cachedTransactions[index];
    let mappedType = t.type;
    if (t.type === 'pay') mappedType = 'payment';
    else if (t.type === 'don') mappedType = 'donation';
    else if (t.type === 'exp') mappedType = 'expense';

    window.editRecordedPayment(
        t.personId || null,
        t.paymentId || null,
        t.paymentIndex !== undefined ? t.paymentIndex : -1,
        t.personName || t.who || null,
        mappedType,
        t.payment || null
    );
};

window.saveEditedPayment = async () => {
    if (!(currentUser && currentUser.admin) || !currentEditedPayment) return;

    const amount = parseFloat(String(document.getElementById('edit-payment-amount').value || '').replace(',', '.'));
    const date = document.getElementById('edit-payment-date').value;
    const description = document.getElementById('edit-payment-desc').value.trim();

    const issuerEl = document.getElementById('edit-payment-issuer');
    const issuer = issuerEl ? issuerEl.value.trim() : '';

    if (Number.isNaN(amount)) {
        alert('Ungültiger Betrag.');
        return;
    }
    if (!date) {
        alert('Bitte ein Datum angeben.');
        return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        alert('Ungültiges Datum.');
        return;
    }

    try {
        if (currentEditedPayment.type === 'payment') {
            await mutatePerson(currentEditedPayment.personId, (draft) => {
                const nextPayments = safeList(draft.payments);
                let targetIdx = currentEditedPayment.targetIndex;
                if (targetIdx < 0 || targetIdx >= nextPayments.length) {
                    targetIdx = nextPayments.findIndex((entry, i) => String(entry.id ?? `idx-${i}`) === String(currentEditedPayment.paymentId));
                }
                if (targetIdx >= 0 && targetIdx < nextPayments.length) {
                    nextPayments[targetIdx] = { ...nextPayments[targetIdx], amount, date, description };
                } else {
                    console.warn("saveEditedPayment: fallback payment match not found, mapping all", currentEditedPayment);
                }
                const totalPaid = calculateTotalPaidLoop(nextPayments);
                return { ...draft, payments: nextPayments, totalPaid };
            });
            showToast('Zahlung aktualisiert');
        } else if (currentEditedPayment.type === 'donation') {
            const remoteDonations = safeList(await apiGet('donations').catch(() => []));
            const targetDonationId = currentEditedPayment.paymentId;
            const idx = remoteDonations.findIndex(d => String(d.id) === String(targetDonationId));

            if (idx >= 0) {
                remoteDonations[idx] = { ...remoteDonations[idx], amount, date };
                await set(ref(db, 'donations'), { ...remoteDonations });
                donations = remoteDonations;
            }
            showToast('Spende aktualisiert');
        } else if (currentEditedPayment.type === 'expense') {
            const remoteExpenses = safeList(await apiGet('expenses').catch(() => []));
            const targetExpenseId = currentEditedPayment.paymentId;
            const idx = remoteExpenses.findIndex(e => String(e.id) === String(targetExpenseId));

            if (idx >= 0) {
                remoteExpenses[idx] = { ...remoteExpenses[idx], amount, date, description, issuer };
                await set(ref(db, 'expenses'), { ...remoteExpenses });
                expenses = remoteExpenses;
            }
            showToast('Ausgabe aktualisiert');
        }

        closeModal('edit-payment-modal');
        currentEditedPayment = null;
        renderPeople();
        renderStats();
        renderSuperAdminPaymentEditor();
    } catch (err) {
        console.error('Fehler beim Bearbeiten:', err);
        showToast('Eintrag konnte nicht aktualisiert werden', 'error');
    }
};

window.deleteRecordedPaymentClick = () => {
    if (!(currentUser && currentUser.admin) || !currentEditedPayment) return;
    openModal('confirm-delete-modal');
};

window.confirmDeleteRecordedPayment = async () => {
    if (!(currentUser && currentUser.admin) || !currentEditedPayment) return;

    closeModal('confirm-delete-modal');
    closeModal('edit-payment-modal');

    try {
        if (currentEditedPayment.type === 'payment') {
            await mutatePerson(currentEditedPayment.personId, (draft) => {
                const nextPayments = safeList(draft.payments).filter((entry, i) => {
                    if (i === currentEditedPayment.targetIndex) return false;
                    if (String(entry.id ?? `idx-${i}`) === String(currentEditedPayment.paymentId)) return false;
                    return true;
                });
                const totalPaid = calculateTotalPaidLoop(nextPayments);
                return { ...draft, payments: nextPayments, totalPaid };
            });
            showToast('Zahlung gelöscht');
        } else if (currentEditedPayment.type === 'donation') {
            const remoteDonations = safeList(await apiGet('donations').catch(() => []));
            const targetDonationId = currentEditedPayment.paymentId;
            const nextDonations = remoteDonations.filter(d => String(d.id) !== String(targetDonationId));
            await set(ref(db, 'donations'), nextDonations);
            donations = nextDonations;
            showToast('Spende gelöscht');
        } else if (currentEditedPayment.type === 'expense') {
            const remoteExpenses = safeList(await apiGet('expenses').catch(() => []));
            const targetExpenseId = currentEditedPayment.paymentId;
            const nextExpenses = remoteExpenses.filter(e => String(e.id) !== String(targetExpenseId));
            await set(ref(db, 'expenses'), nextExpenses);
            expenses = nextExpenses;
            showToast('Ausgabe gelöscht');
        }

        currentEditedPayment = null;
        renderPeople();
        renderStats();
        renderSuperAdminPaymentEditor();
    } catch (err) {
        console.error('Fehler beim Löschen:', err);
        showToast('Eintrag konnte nicht gelöscht werden', 'error');
    }
};

window.approveRequest = async (reqId) => {
    const req = requests.find(r => r.id === reqId);
    if(!req) return;

    try {
        if(req.type === 'payment') {
            await mutatePerson(req.personId, (person) => {
                const payments = safeList(person.payments);
                payments.push({
                    id: Date.now().toString(),
                    amount: parseFloat(req.data.amount),
                    date: req.data.date,
                    description: req.data.note || 'Zahlung (Genehmigt)'
                });
                const totalPaid = (person.totalPaid || 0) + parseFloat(req.data.amount);
                return { ...person, payments, totalPaid };
            });
        } else if(req.type === 'status') {
            await mutatePerson(req.personId, (person) => {
                const changeDate = req.data.date;
                const newStatus = req.data.newStatus;
                const changeDateObj = new Date(changeDate);

                let currentStatusStartDate = person.originalMemberSince || person.memberSince;
                const sortedHistory = safeList(person.statusHistory).slice().sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
                if (sortedHistory.length > 0 && sortedHistory[0].endDate) {
                    currentStatusStartDate = sortedHistory[0].endDate;
                }

                const updatedHistory = safeList(person.statusHistory).filter(entry => new Date(entry.startDate) < changeDateObj);
                if (new Date(currentStatusStartDate) < changeDateObj) {
                    updatedHistory.push({
                        status: person.status,
                        startDate: currentStatusStartDate,
                        endDate: changeDate
                    });
                }

                return { ...person, status: newStatus, statusHistory: updatedHistory };
            });
        } else if(req.type === 'expense') {
            const newExpense = {
                id: Date.now().toString(),
                amount: parseFloat(req.data.amount),
                description: req.data.description + ` (Von: ${req.personName})`,
                date: req.data.date,
                receipt: req.data.receipt
            };
            const currentData = await apiGet('expenses');
            const nextExpenses = [...safeList(currentData), newExpense];
            await set(ref(db, 'expenses'), nextExpenses);
            expenses = nextExpenses;
        } else if(req.type === 'standing_order') {
            await mutatePerson(req.personId, (person) => {
                const standingOrders = safeList(person.standingOrders);
                const newSO = {
                    id: Date.now().toString(),
                    amount: parseFloat(req.data.amount),
                    startDate: req.data.date,
                    note: req.data.note || 'Dauerauftrag (Genehmigt)',
                    lastAutoPayment: null
                };
                standingOrders.push(newSO);
                return { ...person, standingOrders };
            });
        }

        await update(ref(db, 'requests/' + reqId), { status: 'approved' });
        await loadData();
        showToast('Anfrage genehmigt');
    } catch (err) {
        console.error('Fehler beim Genehmigen der Anfrage:', err);
        alert('Anfrage konnte nicht genehmigt werden. Bitte erneut versuchen.');
    }
};

window.rejectRequest = async (reqId) => {
    const reason = prompt("Grund für Ablehnung:");
    if(reason === null) return; // Cancelled

    try {
        await update(ref(db, 'requests/' + reqId), {
            status: 'rejected',
            rejectionReason: reason || 'Kein Grund angegeben'
        });
        await loadData();
        showToast('Anfrage abgelehnt');
    } catch (err) {
        console.error('Fehler beim Ablehnen der Anfrage:', err);
        alert('Anfrage konnte nicht abgelehnt werden. Bitte erneut versuchen.');
    }
};

function renderUserView() {
    if (people.length === 0) {
        document.getElementById('user-status-card').innerHTML = `
            <div style="text-align:center; padding: 20px; color: var(--text-secondary);">
                Kein Mitgliedseintrag gefunden.<br>Bitte kontaktieren Sie einen Administrator.
            </div>
        `;
        return;
    }

    const p = people[0]; // User has only one person (themselves)
    const paidUntil = p._paidUntil ? new Date(p._paidUntil) : null;
    const statusMeta = p._statusMeta || { text: 'Unbekannt', isOverdue: false, isSoonDue: false };
    const overdueAmount = p._overdueAmount || 0;
    const currentStatus = p._currentStatus || p.status;

    // Format date to show only month and year
    let dateText = paidUntil ? monthYearFormatter.format(paidUntil) : 'Nie';

    const statusLabels = {
        'vollverdiener': 'Vollverdiener',
        'geringverdiener': 'Geringverdiener',
        'keinverdiener': 'Keinverdiener',
        'pausiert': 'Pausiert'
    };

    let statusClass = 'user-status-ok';
    let statusColor = 'var(--success)';
    let statusIcon = '✅';

    if (statusMeta.isOverdue) {
        statusClass = 'user-status-overdue';
        statusColor = 'var(--danger)';
        statusIcon = '⚠️';
    } else if (statusMeta.isSoonDue) {
        statusClass = 'user-status-soon';
        statusColor = 'var(--warning)';
        statusIcon = '⏳';
    }

    const monthlyRate = settings[currentStatus] || 0;

    document.getElementById('user-status-card').innerHTML = `
        <!-- Status Hero Card -->
        <div class="user-hero-status ${statusClass}">
            <h2 style="color: ${statusColor}; font-size: 1.25rem; font-weight: 800; margin-bottom: 5px;">
                ${escapeHtml(statusMeta.text)}
            </h2>
            ${(statusMeta.isActiveStandingOrder && !statusMeta.isOverdue) ? '' : `<div style="font-size: 1rem; font-weight: 600; color: var(--text); margin-bottom: 5px;">Bezahlt bis <strong>${dateText}</strong></div>`}
            ${statusMeta.isOverdue ? `
                <div style="margin-top: 15px; padding: 12px; background: rgba(239, 68, 68, 0.1); border-radius: 12px; border: 1px solid rgba(239, 68, 68, 0.3);">
                    <div style="font-size: 0.85rem; opacity: 0.8; margin-bottom: 5px; color: var(--danger);">Offener Betrag</div>
                    <div style="font-size: 1.5rem; font-weight: 800; color: var(--danger);">${formatCurrency(overdueAmount)} €</div>
                </div>
            ` : ''}
        </div>

        <div class="user-info-boxes">
            <div class="user-info-box">
                <div class="user-info-box-label">Monatlicher Beitrag</div>
                <div class="user-info-box-value">${formatCurrency(monthlyRate)} €</div>
            </div>
            <div class="user-info-box">
                <div class="user-info-box-label">Aktueller Status</div>
                <div class="user-info-box-value">${escapeHtml(statusLabels[currentStatus] || currentStatus)}</div>
            </div>
        </div>
    `;

    // Combined History (Timeline)
    const timeline = generateTimelineHTML(p);
    document.getElementById('user-payment-history').innerHTML = `
        <div class="history-header">Verlauf</div>
        ${timeline}
    `;

    // User Requests List
    const myRequests = requests.filter(r => r.userId === currentUser.uid).sort((a,b) => b.timestamp - a.timestamp);
    const reqList = document.getElementById('user-requests-list');

    if(myRequests.length > 0) {
        reqList.innerHTML = myRequests.map(req => {
            let statusBadge, statusBg, statusText;
            if(req.status === 'rejected') {
                statusBadge = '❌';
                statusBg = '#ef444415';
                statusText = 'Abgelehnt';
            } else if(req.status === 'approved') {
                statusBadge = '✅';
                statusBg = '#10b98115'; // A soft green background
                statusText = 'Genehmigt';
            } else {
                statusBadge = '⏳';
                statusBg = '#f59e0b15';
                statusText = 'In Prüfung';
            }

            const typeIcons = { payment: '💰', status: '🔄', expense: '💸', standing_order: '🔁' };
            const typeLabels = { payment: 'Zahlung', status: 'Status', expense: 'Ausgabe', standing_order: 'Dauerauftrag' };

            let details = '';
            if(req.status === 'rejected') {
                details = `<div style="color:var(--danger); font-size:0.85rem; margin-top:8px; padding:10px; background:var(--danger)10; border-radius:8px;">⚠️ ${escapeHtml(req.rejectionReason) || 'Keine Begründung'}</div>`;
            }

            return `
                <div class="user-request-item">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                        <div>
                            <div style="font-size: 1.1rem; font-weight: 700; margin-bottom: 4px;">${typeIcons[req.type]} ${typeLabels[req.type] || req.type}</div>
                            <div style="font-size: 0.85rem; color: var(--text-secondary);">${formatDateFast(req.timestamp)}</div>
                        </div>
                        <div style="background: ${statusBg}; padding: 8px 14px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; white-space: nowrap;">
                            ${statusBadge} ${statusText}
                        </div>
                    </div>
                    ${details}
                </div>
            `;
        }).join('');
    } else {
        reqList.innerHTML = `
            <div style="text-align:center; padding: 30px 20px; color: var(--text-secondary); background: var(--surface); border-radius: 12px;">
                Keine offenen Anfragen
            </div>
        `;
    }
}

function renderPeople() {
    const list = document.getElementById('peopleList');
    const empty = document.getElementById('emptyState');

    if(people.length === 0) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';

    // Data is pre-calculated by backend now
    const processed = people.map(p => {
        return {
            p,
            paidUntil: p._paidUntil ? new Date(p._paidUntil) : null,
            statusMeta: p._statusMeta || { text: '', isOverdue: false, isSoonDue: false },
            overdueAmount: p._overdueAmount || 0
        };
    });

    const overdueItems = processed.filter(x => x.statusMeta.isOverdue);
    const currentItems = processed.filter(x => !x.statusMeta.isOverdue);

    overdueItems.sort((a,b) => a.p.name.localeCompare(b.p.name));
    currentItems.sort((a,b) => a.p.name.localeCompare(b.p.name));

    let overdueHtml = '';
    if(overdueItems.length > 0) {
        overdueHtml += `<h3 class="list-section-title" style="color:var(--danger)">Überfällig (${overdueItems.length})</h3>`;
        overdueHtml += overdueItems.map(item => generatePersonHTML(item.p, item)).join('');
    }

    let validHtml = '';
    if(currentItems.length > 0) {
        validHtml += `<h3 class="list-section-title" style="color:var(--success)">Aktuelle Mitglieder (${currentItems.length})</h3>`;
        validHtml += currentItems.map(item => generatePersonHTML(item.p, item)).join('');
    }

    list.innerHTML = `
        <div class="people-grid-container">
            <div class="people-column overdue-column">${overdueHtml}</div>
            <div class="people-column valid-column">${validHtml}</div>
        </div>
    `;
}

function generateTimelineHTML(person) {
    const historyList = safeList(person.statusHistory);
    // ⚡ Bolt: Store ISO strings for faster sorting
    const history = historyList.map(h => ({
        type: 'status',
        dateStr: h.startDate,
        status: h.status,
        endDate: h.endDate
    }));

    // Find start date of current status
    let currentStatusStart;
    if (historyList.length > 0) {
        currentStatusStart = historyList[historyList.length - 1].endDate;
    } else {
        currentStatusStart = person.originalMemberSince || person.memberSince;
    }

    if (currentStatusStart) {
        history.push({
            type: 'status',
            dateStr: currentStatusStart,
            status: person.status,
            endDate: null
        });
    }

    const payments = safeList(person.payments).map(p => ({
        type: 'payment',
        dateStr: p.date,
        amount: p.amount,
        description: p.description
    }));

    // ⚡ Bolt: Use localeCompare for faster sorting without Date objects
    const allEvents = [...history, ...payments].sort((a, b) => b.dateStr.localeCompare(a.dateStr));

    if (allEvents.length === 0) {
        return '<div style="font-size:0.8rem; color:var(--text-secondary); font-style:italic;">Keine Einträge vorhanden.</div>';
    }

    const statusLabels = {
        'vollverdiener': '💼 Vollverdiener',
        'geringverdiener': '📉 Geringverdiener',
        'keinverdiener': '🎓 Keinverdiener',
        'pausiert': '⏸️ Pausiert'
    };

    const timelineItems = allEvents.map(event => {
        const dateStr = formatDateFast(event.dateStr);
        let content = '';
        let dotClass = 'timeline-dot';

        if (event.type === 'status') {
            const label = statusLabels[event.status] || event.status;
            content = `
                <div style="font-weight: 600;">Statusänderung: ${escapeHtml(label)}</div>
                <div style="font-size: 0.85rem; color: var(--text-secondary);">Gültig ab ${dateStr}</div>
            `;
        } else {
            content = `
                <div style="font-weight: 600;">Zahlung: ${formatCurrency(event.amount)}€</div>
                <div style="font-size: 0.85rem; color: var(--text-secondary);">${escapeHtml(event.description) || 'Keine Notiz'} • ${dateStr}</div>
            `;
        }

        return `
            <div class="timeline-item">
                <div class="${dotClass}"></div>
                <div class="timeline-content">${content}</div>
            </div>
        `;
    }).join('');

    return `<div class="timeline">${timelineItems}</div>`;
}

function generatePersonHTML(p, preCalcData = null) {
    const paidUntil = preCalcData ? preCalcData.paidUntil : (p._paidUntil ? new Date(p._paidUntil) : null);
    const statusMeta = preCalcData ? preCalcData.statusMeta : (p._statusMeta || { text: '', isOverdue: false, isSoonDue: false });
    const overdueAmount = preCalcData ? preCalcData.overdueAmount : (p._overdueAmount || 0);

    const currentStatus = p._currentStatus || p.status;

    let dateText = paidUntil ? monthYearFormatter.format(paidUntil) : 'Nie';
    let pillClass = 'status-ok';
    let cardClass = 'success';

    if(statusMeta.isOverdue) {
        pillClass = 'status-err';
        cardClass = 'danger';
    } else if(statusMeta.isSoonDue) {
        pillClass = 'status-warn';
    }

    const paymentsList = safeList(p.payments);
    const standingOrders = safeList(p.standingOrders);
    const hasStandingOrder = standingOrders.length > 0;
    const soListHtml = hasStandingOrder ? `
        <div class="card" style="margin-top:15px; margin-bottom:15px; background:var(--surface-alt);">
            <div class="card-header" style="font-size:0.9rem; padding:10px 15px;">🔄 Aktive Daueraufträge</div>
            <div class="card-body" style="padding:10px 15px;">
                ${standingOrders.map(so => {
                    const isEnded = so.endDate && new Date(so.endDate) < new Date();
                    const style = isEnded ? 'opacity:0.6;' : '';
                    return `
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:5px; ${style}">
                        <div>
                            <div style="font-size:0.9rem; font-weight:600;">${formatCurrency(so.amount)} € / Monat</div>
                            <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:2px;">${escapeHtml(so.note || 'Ohne Notiz')}</div>
                            <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px;">
                                Start: ${formatDateFast(so.startDate)}
                                ${so.endDate ? `<br>Ende: ${formatDateFast(so.endDate)}` : ''}
                            </div>
                        </div>
                        ${(true) ? `
                        <button class="btn-icon text-danger" data-pid="${escapeHtml(p.id)}" data-soid="${escapeHtml(so.id)}" onclick="openEndStandingOrderModal(this.dataset.pid, this.dataset.soid)" title="Bearbeiten/Beenden" style="background:none; border:none; padding:4px;">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                        </button>
                        ` : ''}
                    </div>
                    `;
                }).join('<hr style="margin:8px 0; border:0; border-top:1px solid var(--border);">')}
            </div>
        </div>
    ` : '';

    return `
        <div class="person-wrapper">
            <div id="person-item-${p.id}" class="person-item" role="button" tabindex="0" aria-expanded="false" data-id="${escapeHtml(p.id)}" onclick="toggleDetails(this.dataset.id)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); toggleDetails(this.dataset.id);}">
                <div class="person-pill">
                    <div class="person-left">
                        <div class="person-name">
                            ${escapeHtml(p.name)}
                            <span class="chevron">›</span>
                        </div>
                        <span class="person-status">${escapeHtml(currentStatus)}</span>
                    </div>
                    <div class="person-right">
                        ${(statusMeta.isActiveStandingOrder && !statusMeta.isOverdue) ? '' : `<span class="payment-pill ${pillClass}">${dateText}</span>`}
                        <span class="time-remaining">${escapeHtml(statusMeta.text)}</span>
                    </div>
                </div>
            </div>
            <div id="drawer-${p.id}" class="person-details">
                <div class="details-content">

                    <div class="details-status-card ${cardClass}">
                        ${(statusMeta.isActiveStandingOrder && !statusMeta.isOverdue) ? '' : `
                        <div class="details-row">
                            <span class="details-label">Bezahlt bis</span>
                            <span class="details-value">${dateText}</span>
                        </div>`}
                        <div class="details-row">
                            <span class="details-label">Status</span>
                            <span class="details-value" style="text-transform:capitalize">${p.status}</span>
                        </div>
                        ${statusMeta.isOverdue ? `
                        <div class="details-row" style="margin-top:12px; padding-top:12px; border-top:1px solid rgba(0,0,0,0.05)">
                            <span class="details-label text-danger">Offener Betrag</span>
                            <span class="details-value text-danger">${formatCurrency(overdueAmount)} €</span>
                        </div>
                        ` : ''}
                    </div>

                    ${soListHtml}

                    <div class="details-actions" style="${(currentUser && !currentUser.admin) ? 'display:none' : ''}">
                        <button class="btn btn-primary" data-id="${escapeHtml(p.id)}" onclick="openPaymentModal(this.dataset.id)">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h12"></path><path d="M4 14h9"></path><path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"></path></svg>
                            Zahlung erfassen
                        </button>
                        <div class="secondary-actions">
                            <button class="btn btn-secondary" data-id="${escapeHtml(p.id)}" onclick="openChangeStatusModal(this.dataset.id)">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                                Status
                            </button>
                            <button class="btn btn-secondary" data-id="${escapeHtml(p.id)}" onclick="sendStatusEmail(this.dataset.id)">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
                                E-Mail
                            </button>
                        </div>
                    </div>

                    <div class="history-header">Verlauf</div>
                    <div id="timeline-${p.id}">
                        <div style="padding:10px; color:var(--text-secondary); font-size:0.8rem; font-style:italic;">Lade Verlauf...</div>
                    </div>

                    <div style="display: ${!(currentUser && currentUser.admin) ? 'none' : 'flex'}; justify-content: flex-end; margin-top: 20px;">
                        <button class="btn btn-secondary btn-small" style="border-color: var(--danger); color: var(--danger); font-size: 0.85rem; padding: 6px 12px; display: inline-flex; align-items: center; gap: 6px;" data-id="${escapeHtml(p.id)}" onclick="deletePersonClick(this.dataset.id)">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                            Mitglied löschen
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function renderStats() {
    try {
        const response = await fetchWithAuth(`${config.apiBaseUrl}/stats`);
        if (!response.ok) throw new Error('Stats fetch failed');
        const data = await response.json();

        // ⚡ Bolt: Using persistent currencyFormatter
        document.getElementById('heroAmount').textContent = currencyFormatter.format(data.totalBalance || 0);
        document.getElementById('totalIncome').textContent = currencyFormatter.format(data.totalIncome || 0);
        document.getElementById('totalExpenses').textContent = currencyFormatter.format(data.totalExpenses || 0);

        const totalMembers = people.length;
        let totalOverdue = 0;
        people.forEach(p => {
            totalOverdue += (p._overdueAmount || 0);
        });

        document.getElementById('totalMembers').textContent = totalMembers;
        document.getElementById('totalOverdue').textContent = currencyFormatter.format(totalOverdue);

        if (data.chartData && Array.isArray(data.chartData.dataPoints)) {
            chartDataCache = {
                dataPoints: data.chartData.dataPoints.map(dp => ({ ...dp, date: new Date(dp.date) })),
                minVal: data.chartData.minVal,
                maxVal: data.chartData.maxVal
            };
        } else {
            chartDataCache = null;
        }
        renderBalanceChart();
    } catch (err) {
        console.error('Fehler beim Laden der Statistiken:', err);
    }
}

function renderBalanceChart() {
    const canvas = document.getElementById('balanceChart');
    if (!canvas || canvas.offsetParent === null) return; // Don't render if hidden

    // Responsive Canvas
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    if (!chartDataCache || !chartDataCache.dataPoints || chartDataCache.dataPoints.length === 0) return;

    const { dataPoints, minVal, maxVal } = chartDataCache;

    // Palette: Accessible Chart Description
    if (dataPoints && dataPoints.length > 0) {
        const startBalance = formatCurrency(dataPoints[0].y);
        const endBalance = formatCurrency(dataPoints[dataPoints.length - 1].y);
        canvas.setAttribute('aria-label', `Kontostandsverlauf über 90 Tage. Start: ${startBalance} Euro. Aktuell: ${endBalance} Euro.`);
    }

    // 3. Drawing
    // Margins
    const padTop = 20;
    const padBottom = 20;
    const padLeft = 10;
    const padRight = 10;

    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;

    // Scale
    const range = maxVal - minVal;
    // Avoid division by zero
    const safeRange = range === 0 ? 1 : range;

    const getX = (i) => padLeft + (i / 90) * plotWidth;
    const getY = (val) => padTop + plotHeight - ((val - minVal) / safeRange) * plotHeight;

    // Draw Gradient Area
    const grad = ctx.createLinearGradient(0, padTop, 0, height - padBottom);
    grad.addColorStop(0, "rgba(6, 182, 212, 0.2)");
    grad.addColorStop(1, "rgba(6, 182, 212, 0.0)");

    ctx.beginPath();
    ctx.moveTo(getX(0), getY(dataPoints[0].y));

    for (let i = 1; i < dataPoints.length; i++) {
        ctx.lineTo(getX(i), getY(dataPoints[i].y));
    }

    ctx.lineTo(getX(90), height - padBottom);
    ctx.lineTo(getX(0), height - padBottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw Line
    ctx.beginPath();
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#06b6d4';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.moveTo(getX(0), getY(dataPoints[0].y));
    for (let i = 1; i < dataPoints.length; i++) {
        ctx.lineTo(getX(i), getY(dataPoints[i].y));
    }
    ctx.stroke();

    // Draw Start/End labels (Dates)
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#64748b';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(shortDateFormatter.format(dataPoints[0].date), padLeft, height - 5);

    ctx.textAlign = 'right';
    ctx.fillText(shortDateFormatter.format(dataPoints[90].date), width - padRight, height - 5);
}

// Re-render chart on resize
let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        requestAnimationFrame(renderBalanceChart);
    }, 100);
});

window.renderHistoryTab = async function(resetLimit = true) {
    if (resetLimit) {
        transactionPage = 1;
        cachedTransactions = null;
    }

    const container = document.getElementById('history-page-list');
    if (!container) return;

    if (resetLimit) {
        const skeletonHtml = Array(15).fill(`
            <div class="trans-item" style="pointer-events: none;">
                <div style="display: flex; align-items: center; flex: 1;">
                    <div class="skeleton" style="width: 40px; height: 40px; border-radius: 50%; margin-right: 16px; flex-shrink: 0;"></div>
                    <div class="trans-left" style="gap: 6px; flex: 1;">
                        <div class="skeleton" style="width: 140px; height: 16px;"></div>
                        <div class="skeleton" style="width: 100px; height: 12px; margin-top: 4px;"></div>
                    </div>
                </div>
                <div class="skeleton" style="width: 70px; height: 18px;"></div>
            </div>
        `).join('');
        container.innerHTML = skeletonHtml;
    }

    try {
        const queryParam = transactionSearchQuery ? `&search=${encodeURIComponent(transactionSearchQuery)}` : '';
        const response = await fetchWithAuth(`${config.apiBaseUrl}/transactions?page=${transactionPage}&perPage=${transactionPerPage}${queryParam}`);
        if (!response.ok) throw new Error('Failed to fetch transactions');
        const data = await response.json();

        if (resetLimit) {
            cachedTransactions = data.items;
        } else {
            cachedTransactions = [...(cachedTransactions || []), ...data.items];
        }
        transactionTotalItems = data.totalItems;

        if (!cachedTransactions || cachedTransactions.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:30px 20px; color:var(--text-secondary);">Keine Buchungen vorhanden.</div>';
            return;
        }

        const isSuperAdmin = !!(currentUser && currentUser.admin);

        let lastDateFormatted = null;
        let html = '';

        cachedTransactions.forEach((t, index) => {
            const tDateFormatted = t.date ? formatDateFast(t.date) : 'Kein Datum';

            if (tDateFormatted !== lastDateFormatted) {
                html += `<div style="margin: ${index === 0 ? '0' : '20px'} 0 8px 10px; font-weight: bold; font-size: 0.9rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px;">${tDateFormatted}</div>`;
                lastDateFormatted = tDateFormatted;
            }

            const isExp = t.type === 'exp';
            const color = isExp ? 'text-danger' : 'text-success';
            const sign = isExp ? '-' : '+';

            let iconSvg = '';
            let iconClass = '';
            if (t.type === 'pay') {
                iconClass = 'pay';
                iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
            } else if (t.type === 'don') {
                iconClass = 'don';
                iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
            } else {
                iconClass = 'exp';
                iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>';
            }

            const hasReceipt = t.receipt ? '<span style="margin-left:5px" title="Beleg vorhanden">📷</span>' : '';

            const editBtn = isSuperAdmin ? `
                <button class="btn btn-secondary btn-small" style="padding: 6px; border-radius: 8px; margin-left: 10px;"
                    onclick="event.stopPropagation(); editRecordedPaymentByIndex(${index})"
                    aria-label="Bearbeiten">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
            ` : '';

            const uidAttr = (t.type === 'pay' && t.personUid) ? ` data-uid="${t.personUid}"` : '';

            let descHtml = t.description ? escapeHtml(t.description) : '-';
            html += `
                <div class="trans-item" role="button" tabindex="0" data-id="${escapeHtml(t.id)}" data-type="${escapeHtml(t.type)}" onclick="showTransactionDetails(this.dataset.id, this.dataset.type)" onkeydown="if(event.key==='Enter'||event.key===' '){showTransactionDetails(this.dataset.id, this.dataset.type)}" style="cursor:pointer;">
                    <div style="display: flex; align-items: center; flex: 1;">
                        <div class="trans-icon-wrapper ${iconClass}"${uidAttr}>
                            ${iconSvg}
                        </div>
                        <div class="trans-left" style="flex: 1;">
                            <span style="font-weight:600;">${escapeHtml(t.who)}</span>
                            <div class="trans-meta">${descHtml} ${hasReceipt}</div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center;">
                        <div class="trans-amount ${color}" style="font-size: 1.1rem;">${sign}${formatCurrency(t.amount)}€</div>
                        ${editBtn}
                    </div>
                </div>
            `;
        });

        if (cachedTransactions.length < transactionTotalItems) {
            html += `
                <div style="text-align:center; padding:20px;">
                    <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom: 12px;">Es werden ${cachedTransactions.length} von ${transactionTotalItems} Buchungen angezeigt.</div>
                    <button class="btn btn-secondary" onclick="loadMoreHistory()">Mehr laden...</button>
                </div>
            `;
        }

        const scrollContainer = container.parentElement;
        const previousScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

        container.innerHTML = html;

        // Lazy load profile pictures for payments
        const iconWrappers = container.querySelectorAll('.trans-icon-wrapper[data-uid]');
        for (const wrapper of iconWrappers) {
            const uid = wrapper.getAttribute('data-uid');
            getProfilePicUrl(uid).then(url => {
                if (url) {
                    wrapper.innerHTML = `<img src="${url}" alt="Profil" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block;">`;
                    wrapper.style.background = 'transparent'; // Remove soft background color
                    wrapper.style.color = 'inherit'; // Reset color
                }
            });
        }

        if (!resetLimit && scrollContainer) {
            scrollContainer.scrollTop = previousScrollTop;
        }
    } catch (err) {
        console.error('Fehler beim Laden der Transaktionen:', err);
        container.innerHTML = '<div style="text-align:center; padding:30px 20px; color:var(--danger);">Fehler beim Laden der Buchungen.</div>';
    }
};

window.loadMoreHistory = function() {
    transactionPage += 1;
    window.renderHistoryTab(false);
};

window.addPerson = async () => {
    if (!validateRequired(['new-person-name', 'new-person-start'])) return;

    setButtonLoading('btn-add-person', true, "Speichert...");
    const name = document.getElementById('new-person-name').value;
    const status = document.getElementById('new-person-status').value;
    const start = document.getElementById('new-person-start').value;

    const newP = {
        id: Date.now().toString(),
        name,
        status,
        memberSince: start,
        originalMemberSince: start,
        totalPaid: 0,
        statusHistory: [],
        payments: []
    };

    try {
        await saveNewPerson(newP);
        await renderAll();
        closeModal('add-person-modal');
        document.getElementById('new-person-name').value = ''; // Clear input on success
        showToast('Person hinzugefügt');
    } catch (err) {
        console.error('Fehler beim Anlegen der Person:', err);
        alert('Speichern fehlgeschlagen. Bitte erneut versuchen.');
    } finally {
        setButtonLoading('btn-add-person', false);
    }
};

window.addPayment = async () => {
    if (!validateRequired(['payment-amount', 'payment-date'])) return;

    setButtonLoading('btn-add-payment', true, "Buche...");

    const amt = parseFloat(document.getElementById('payment-amount').value.replace(',', '.'));
    const date = document.getElementById('payment-date').value;
    const desc = document.getElementById('payment-desc').value;
    const isStandingOrder = document.getElementById('payment-is-standing-order').checked;

    if(!currentPersonId || isNaN(amt)) {
        setButtonLoading('btn-add-payment', false);
        return;
    }

    try {
        const updated = await mutatePerson(currentPersonId, (person) => {
            if (isStandingOrder) {
                const standingOrders = safeList(person.standingOrders);
                const newSO = {
                    id: Date.now().toString(),
                    amount: amt,
                    startDate: date,
                    note: desc,
                    lastAutoPayment: null
                };
                standingOrders.push(newSO);
                return { ...person, standingOrders };
            } else {
                const payments = safeList(person.payments);
                payments.push({ amount: amt, date, description: desc, id: Date.now() });
                const totalPaid = (person.totalPaid || 0) + amt;
                return { ...person, payments, totalPaid };
            }
        });

        if (!updated) {
            alert('Person nicht gefunden.');
            return;
        }

        closeModal('add-payment-modal');
        if (currentUser && !currentUser.admin) {
            renderUserView();
        } else {
            renderPeople();
            renderStats();
            renderSuperAdminPaymentEditor();
        }
        document.getElementById('payment-is-standing-order').checked = false;
        const lbl = document.getElementById('payment-date-label');
        if(lbl) lbl.innerText = 'Datum';
        showToast('Zahlung gebucht');
    } catch (err) {
        console.error('Fehler beim Speichern der Zahlung:', err);
        alert('Zahlung konnte nicht gespeichert werden. Bitte erneut versuchen.');
    } finally {
        setButtonLoading('btn-add-payment', false);
    }
};

window.addDonation = async () => {
    if (!validateRequired(['donation-amount', 'donation-date', 'donation-name'])) return;

    setButtonLoading('btn-add-donation', true, "Speichert...");

    const amt = parseFloat(document.getElementById('donation-amount').value.replace(',', '.'));
    if(isNaN(amt)) {
        setButtonLoading('btn-add-donation', false);
        return;
    }
    const newDonation = { amount: amt, name: document.getElementById('donation-name').value, date: document.getElementById('donation-date').value, id: Date.now() };
    try {
        const currentData = await apiGet('donations');
        const nextDonations = [...safeList(currentData), newDonation];
        await set(ref(db, 'donations'), { ...nextDonations });
        donations = nextDonations;
        closeModal('add-donation-modal');
        renderStats();
        renderSuperAdminPaymentEditor();
        showToast('Spende gespeichert');
    } catch (err) {
        console.error('Fehler beim Speichern der Spende:', err);
        alert('Spende konnte nicht gespeichert werden. Bitte erneut versuchen.');
    } finally {
        setButtonLoading('btn-add-donation', false);
    }
};

window.addExpense = async () => {
    if (!validateRequired(['expense-amount', 'expense-date', 'expense-issuer', 'expense-desc'])) return;

    setButtonLoading('btn-add-expense', true, "Speichert...");

    const amt = parseFloat(document.getElementById('expense-amount').value.replace(',', '.'));
    if(isNaN(amt)) {
        setButtonLoading('btn-add-expense', false);
        return;
    }

    const issuer = document.getElementById('expense-issuer').value;
    const date = document.getElementById('expense-date').value;
    const desc = document.getElementById('expense-desc').value;

    let receiptFilename = null;
    const fileInput = document.getElementById('expense-receipt');
    if (fileInput && fileInput.files.length > 0) {
        try {
            setButtonLoading('btn-add-expense', true, "Lade hoch...");
            receiptFilename = await uploadReceipt(fileInput.files[0], issuer, date);
        } catch (err) {
            console.error(err);
            alert("Fehler beim Hochladen des Belegs: " + err.message);
            setButtonLoading('btn-add-expense', false);
            return;
        }
    }

    const newExpense = {
        amount: amt,
        issuer: issuer,
        description: desc,
        date: date,
        id: Date.now(),
        receipt: receiptFilename
    };
    try {
        const currentData = await apiGet('expenses');
        const nextExpenses = [...safeList(currentData), newExpense];
        await set(ref(db, 'expenses'), { ...nextExpenses });
        expenses = nextExpenses;
        closeModal('add-expense-modal');
        renderStats();
        renderSuperAdminPaymentEditor();
        document.getElementById('expense-amount').value = '';
        document.getElementById('expense-issuer').value = '';
        document.getElementById('expense-desc').value = '';
        if(fileInput) fileInput.value = '';
        showToast('Ausgabe gespeichert');
    } catch (err) {
        console.error('Fehler beim Speichern der Ausgabe:', err);
        alert('Ausgabe konnte nicht gespeichert werden. Bitte erneut versuchen.');
    } finally {
        setButtonLoading('btn-add-expense', false);
    }
};

window.deletePersonClick = (id) => {
    editingPersonId = id;
    openModal('confirm-delete-person-modal');
};

window.confirmDeletePerson = async () => {
    if (!editingPersonId) return;

    closeModal('confirm-delete-person-modal');

    try {
        await remove(ref(db, 'people/' + editingPersonId));
        people = people.filter(p => String(p.id) !== String(editingPersonId));
        await renderAll();
        showToast('Mitglied erfolgreich gelöscht');
    } catch (err) {
        console.error('Fehler beim Löschen der Person:', err);
        showToast('Mitglied konnte nicht gelöscht werden', 'error');
    } finally {
        editingPersonId = null;
    }
};

let editingSoId = null;
let editingPersonId = null;

window.openEndStandingOrderModal = (personId, soId) => {
    editingPersonId = personId;
    editingSoId = soId;

    // Find SO to set default date?
    const person = people.find(p => String(p.id) === String(personId));
    if (person) {
        const so = safeList(person.standingOrders).find(s => String(s.id) === String(soId));
        if (so && so.endDate) {
            document.getElementById('end-so-date').value = so.endDate;
        } else {
            document.getElementById('end-so-date').value = new Date().toISOString().split('T')[0];
        }
    }

    openModal('end-standing-order-modal');
};

window.saveStandingOrderEnd = async () => {
    if (!editingPersonId || !editingSoId) return;

    const endDate = document.getElementById('end-so-date').value;
    if (!endDate) { alert("Bitte Datum wählen"); return; }

    try {
        const updated = await mutatePerson(editingPersonId, (person) => {
            const endDateObj = new Date(endDate);
            endDateObj.setHours(23, 59, 59, 999);
            const today = new Date();

            // 1. Update SO end date
            let standingOrders = safeList(person.standingOrders).map(so => {
                if (String(so.id) === String(editingSoId)) {
                    return { ...so, endDate };
                }
                return so;
            });

            // 2. Remove future auto-payments related to this SO
            const payments = safeList(person.payments).filter(p => {
                if (p.isAuto && p.id.startsWith(`auto_${editingSoId}_`)) {
                    const pDate = new Date(p.date);
                    if (pDate > endDateObj) {
                        return false;
                    }
                }
                return true;
            });

            // 3. Remove SO if expired (delete itself after end date)
            if (endDateObj < today) {
                 standingOrders = standingOrders.filter(so => String(so.id) !== String(editingSoId));
            }

            const totalPaid = calculateTotalPaidLoop(payments);
            return { ...person, standingOrders, payments, totalPaid };
        });

        await renderAll();
        closeModal('end-standing-order-modal');
        showToast('Dauerauftrag aktualisiert');
    } catch (err) {
        console.error('Fehler beim Beenden:', err);
        alert('Fehler beim Speichern.');
    }
};

window.deleteStandingOrderCompletely = async () => {
    if (!confirm("Dauerauftrag wirklich komplett entfernen? Historie geht verloren.")) return;

    try {
        await mutatePerson(editingPersonId, (person) => {
            const standingOrders = safeList(person.standingOrders).filter(so => String(so.id) !== String(editingSoId));
            return { ...person, standingOrders };
        });
        await renderAll();
        closeModal('end-standing-order-modal');
        showToast('Dauerauftrag gelöscht');
    } catch (err) {
        console.error('Fehler beim Löschen:', err);
        alert('Fehler beim Löschen.');
    }
};

window.deleteEditedPayment = async () => {
    if (!isSuperAdminUser() || !currentEditedPayment) return;

    if (!confirm('Achtung: Soll dieser Eintrag wirklich gelöscht werden? Dies kann nicht rückgängig gemacht werden.')) {
        return;
    }

    try {
        if (currentEditedPayment.type === 'payment') {
            await mutatePerson(currentEditedPayment.personId, (draft) => {
                const nextPayments = safeList(draft.payments).filter((_, i) => i !== currentEditedPayment.targetIndex);
                const totalPaid = calculateTotalPaidLoop(nextPayments);
                return { ...draft, payments: nextPayments, totalPaid };
            });
            showToast('Zahlung gelöscht');
        } else if (currentEditedPayment.type === 'donation') {
            const remoteDonations = safeList(await apiGet('donations').catch(() => []));
            const targetDonationId = currentEditedPayment.paymentId;
            const updatedDonations = remoteDonations.filter(d => String(d.id) !== String(targetDonationId));

            await set(ref(db, 'donations'), updatedDonations.length > 0 ? { ...updatedDonations } : null);
            donations = updatedDonations;
            showToast('Spende gelöscht');
        } else if (currentEditedPayment.type === 'expense') {
            const remoteExpenses = safeList(await apiGet('expenses').catch(() => []));
            const targetExpenseId = currentEditedPayment.paymentId;
            const updatedExpenses = remoteExpenses.filter(e => String(e.id) !== String(targetExpenseId));

            await set(ref(db, 'expenses'), updatedExpenses.length > 0 ? { ...updatedExpenses } : null);
            expenses = updatedExpenses;
            showToast('Ausgabe gelöscht');
        }

        closeModal('edit-payment-modal');
        if (typeof loadData === 'function') loadData();
    } catch (e) {
        console.error("Error deleting payment:", e);
        alert('Fehler beim Löschen des Eintrags.');
    }
};

window.deleteStandingOrder = async (personId, soId) => {
    // Legacy mapping or just redirect
    openEndStandingOrderModal(personId, soId);
};

// --- STATUS CHANGE HANDLERS ---

window.openPaymentModal = (id) => {
    currentPersonId = id;
    openModal('add-payment-modal');
};

window.openChangeStatusModal = (id) => {
    currentPersonId = id;
    document.getElementById('change-status-date').value = new Date().toISOString().split('T')[0];
    openModal('change-status-modal');
};

window.sendStatusEmail = async (personId) => {
    if (!currentUser || !currentUser.admin) return;

    const person = people.find(p => String(p.id) === String(personId));
    if (!person) {
        showToast('Person nicht gefunden', 'error');
        return;
    }

    let email = null;
    if (person.uid) {
        const linkedUser = users.find(u => u.uid === person.uid);
        if (linkedUser && linkedUser.email) {
            email = linkedUser.email;
        }
    }

    if (!email) {
        showToast('Keine E-Mail-Adresse für diese Person hinterlegt', 'error');
        return;
    }

    const statusMeta = person._statusMeta || { text: '', isOverdue: false, isSoonDue: false };
    const overdueAmount = person._overdueAmount || 0;
    const currentStatus = person._currentStatus || person.status;

    const statusLabels = {
        'vollverdiener': 'Vollverdiener',
        'geringverdiener': 'Geringverdiener',
        'keinverdiener': 'Keinverdiener',
        'pausiert': 'Pausiert'
    };
    const readableStatus = statusLabels[currentStatus] || currentStatus;
    const appName = config.appName || "Nova";

    const paidUntilDate = person._paidUntil ? new Date(person._paidUntil) : calculatePaidUntil(person);
    const paidUntilText = paidUntilDate ? monthYearFormatter.format(paidUntilDate) : 'Nie';

    let overdueMonths = 0;
    if (paidUntilDate) {
        const today = new Date();
        const currentTotal = today.getFullYear() * 12 + today.getMonth();
        const paidTotal = paidUntilDate.getFullYear() * 12 + paidUntilDate.getMonth();
        const diff = paidTotal - currentTotal;
        if (diff < 0) {
            overdueMonths = Math.abs(diff);
        }
    }

    const hasStandingOrder = statusMeta.isActiveStandingOrder;

    let customMessage = '';
    let customHtmlMessage = '';

    if (hasStandingOrder) {
        customMessage = `Wir haben festgestellt, dass dein Dauerauftrag aktiv ist – du musst dich also um nichts weiter kümmern!`;
        customHtmlMessage = `<div style="background-color: #F0FDF4; border-left: 4px solid #22C55E; padding: 15px; border-radius: 8px; margin-bottom: 25px;"><p style="margin: 0; color: #15803D; font-size: 16px; font-weight: 600;">Wir haben festgestellt, dass dein Dauerauftrag aktiv ist – du musst dich also um nichts weiter kümmern!</p></div>`;
    } else if (statusMeta.isOverdue) {
        let monthStr = overdueMonths === 1 ? 'einen Monat' : `${overdueMonths} Monate`;
        customMessage = `Das bedeutet, dass dein Beitrag aktuell für ${monthStr} überfällig ist.\nInsgesamt beläuft sich der offene Betrag auf ${formatCurrency(overdueAmount)} €.`;
        customHtmlMessage = `<div style="background-color: #FEF2F2; border-left: 4px solid #EF4444; padding: 15px; border-radius: 8px; margin-bottom: 25px;"><p style="margin: 0 0 5px 0; color: #B91C1C; font-size: 16px;">Das bedeutet, dass dein Beitrag aktuell für <strong>${monthStr}</strong> überfällig ist.</p><p style="margin: 0; color: #B91C1C; font-size: 16px; font-weight: 600;">Insgesamt beläuft sich der offene Betrag auf ${formatCurrency(overdueAmount)} €.</p></div>`;
    } else {
        customMessage = `Dein Beitragskonto ist damit bestens ausgeglichen. Vielen Dank dafür!`;
        customHtmlMessage = `<div style="background-color: #F0FDF4; border-left: 4px solid #22C55E; padding: 15px; border-radius: 8px; margin-bottom: 25px;"><p style="margin: 0; color: #15803D; font-size: 16px; font-weight: 600;">Dein Beitragskonto ist damit bestens ausgeglichen. Vielen Dank dafür!</p></div>`;
    }

    const subject = `Dein Kassenstatus - ${appName}`;

    const text = `Hallo ${person.name},\n\nwir möchten dir ein kurzes Update zu deinem aktuellen Status in der Kasse geben.\n\nDein Beitragstarif ist derzeit auf '${readableStatus}' eingestellt.\nNach unseren Aufzeichnungen hast du deine Beiträge bis einschließlich ${paidUntilText} bezahlt.\n\n${customMessage}\n\nBei Fragen kannst du dich jederzeit gerne melden.\n\nLiebe Grüße,\ndein ${appName} Team`;

    const html = `
        <div style="font-family: sans-serif; color: #2D3748; background-color: #F8FAFC; padding: 40px 20px;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
                <div style="padding: 30px; text-align: center; border-bottom: 1px solid #E2E8F0;">
                    <h1 style="margin: 0; color: #14B8A6; font-size: 24px; font-weight: 600;">${escapeHtml(appName)}</h1>
                </div>
                <div style="padding: 40px 30px;">
                    <h2 style="margin-top: 0; margin-bottom: 20px; font-size: 20px; font-weight: 600; color: #1A202C;">Hallo ${escapeHtml(person.name)},</h2>
                    <p style="margin: 0 0 15px 0; font-size: 16px; line-height: 1.5;">wir möchten dir ein kurzes Update zu deinem aktuellen Status in der Kasse geben.</p>
                    <p style="margin: 0 0 15px 0; font-size: 16px; line-height: 1.5;">Dein Beitragstarif ist derzeit auf <strong style="color: #14B8A6;">${escapeHtml(readableStatus)}</strong> eingestellt.</p>
                    <p style="margin: 0 0 25px 0; font-size: 16px; line-height: 1.5;">Nach unseren Aufzeichnungen hast du deine Beiträge bis einschließlich <strong style="color: #4A5568;">${escapeHtml(paidUntilText)}</strong> bezahlt.</p>
                    ${customHtmlMessage}
                    <p style="margin: 0 0 5px 0; font-size: 16px; color: #4A5568;">Bei Fragen kannst du dich jederzeit gerne melden.</p>
                    <br>
                    <p style="margin: 0 0 5px 0; font-size: 16px; color: #4A5568;">Liebe Grüße,</p>
                    <p style="margin: 0; font-size: 16px; font-weight: 600; color: #2D3748;">dein ${escapeHtml(appName)} Team</p>
                </div>
            </div>
        </div>
    `;

    try {
        const token = await auth.currentUser.getIdToken();
        const response = await fetch(`${config.apiBaseUrl}/send-email`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ to: email, subject, text, html })
        });

        if (response.ok) {
            showToast('Status-E-Mail gesendet');
        } else {
            showToast('Fehler beim Senden der E-Mail', 'error');
            console.error('Email API response not ok:', await response.text());
        }
    } catch (err) {
        console.error('Fehler beim Senden der Status-E-Mail:', err);
        showToast('Fehler beim Senden der E-Mail', 'error');
    }
};

window.saveStatusChange = async () => {
    if(!currentPersonId) return;

    const newStatus = document.getElementById('change-status-select').value;
    const changeDate = document.getElementById('change-status-date').value;

    if (!changeDate) {
        alert("Bitte ein Datum angeben.");
        return;
    }

    try {
        const updated = await mutatePerson(currentPersonId, (person) => {
            const changeDateObj = new Date(changeDate);
            const memberSinceDate = new Date(person.originalMemberSince || person.memberSince);

            if (changeDateObj < memberSinceDate) {
                throw new Error('Änderungsdatum liegt vor Mitgliedschaft.');
            }

            let history = safeList(person.statusHistory)
                .filter(entry => new Date(entry.startDate) < changeDateObj)
                .map(entry => {
                    if (entry.endDate) {
                        const entryEnd = new Date(entry.endDate);
                        if (entryEnd > changeDateObj) {
                            return { ...entry, endDate: changeDate };
                        }
                    }
                    return entry;
                });

            let currentStatusStartDate = person.originalMemberSince || person.memberSince;
            const sortedHistory = history.slice().sort((a, b) => new Date(b.endDate || 0) - new Date(a.endDate || 0));
            if (sortedHistory.length > 0 && sortedHistory[0].endDate) {
                currentStatusStartDate = sortedHistory[0].endDate;
            }

            if (new Date(currentStatusStartDate) < changeDateObj) {
                history.push({
                    status: person.status,
                    startDate: currentStatusStartDate,
                    endDate: changeDate
                });
            }

            return { ...person, status: newStatus, statusHistory: history };
        });

        if (!updated) {
            alert('Person nicht gefunden.');
            return;
        }

        await renderAll();
        closeModal('change-status-modal');
        showToast('Status geändert');
    } catch (err) {
        console.error('Fehler bei der Statusänderung:', err);
        alert('Statusänderung fehlgeschlagen: ' + err.message);
    }
};

async function loadAdvancedSystemConfig() {
    if (!isSuperAdminUser()) return;
    try {
        const response = await fetchWithAuth(`${config.apiBaseUrl}/admin/system-config`);
        if (!response.ok) {
            throw new Error(await response.text());
        }
        const data = await response.json();
        advancedConfigAppName = data.appName || null;
        document.getElementById('super-admin-app-name').value = data.appName || '';
        document.getElementById('super-admin-smtp-host').value = data.smtp?.host || '';
        document.getElementById('super-admin-smtp-port').value = data.smtp?.port || '';
        document.getElementById('super-admin-smtp-secure').checked = !!data.smtp?.secure;
        document.getElementById('super-admin-smtp-user').value = data.smtp?.user || '';
        document.getElementById('super-admin-smtp-pass').value = data.smtp?.pass || '';
        advancedConfigLoaded = true;
        await loadAiConfig();
    } catch (err) {
        console.error('Fehler beim Laden der erweiterten Konfiguration:', err);
        showToast('Erweiterte Konfiguration konnte nicht geladen werden', 'error');
    }
}

window.saveAdvancedSystemConfig = async () => {
    if (!isSuperAdminUser()) return;
    try {
        const appName = document.getElementById('super-admin-app-name').value.trim() || advancedConfigAppName || config.appName;
        if (!appName) {
            throw new Error('App-Name konnte nicht ermittelt werden. Dies kann auf fehlende Konfigurationsdaten hinweisen. Bitte Seite neu laden.');
        }

        const payload = {
            appName,
            smtp: null
        };

        const smtpHost = document.getElementById('super-admin-smtp-host').value.trim();
        if (smtpHost) {
            const smtpPortRaw = document.getElementById('super-admin-smtp-port').value.trim();
            payload.smtp = {
                host: smtpHost,
                port: smtpPortRaw ? parseInt(smtpPortRaw, 10) : 465,
                secure: document.getElementById('super-admin-smtp-secure').checked,
                user: document.getElementById('super-admin-smtp-user').value.trim(),
                pass: document.getElementById('super-admin-smtp-pass').value
            };
            if (!payload.smtp.port || Number.isNaN(payload.smtp.port)) {
                throw new Error('SMTP Port ist ungültig.');
            }
        }

        const response = await fetchWithAuth(`${config.apiBaseUrl}/admin/system-config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            let errMsg;
            const responseClone = response.clone();
            try {
                const errData = await response.json();
                errMsg = errData.error || JSON.stringify(errData);
            } catch {
                errMsg = await responseClone.text();
            }
            throw new Error(errMsg);
        }
        advancedConfigAppName = appName;
        showToast('System-Konfiguration gespeichert');
    } catch (err) {
        console.error('Fehler beim Speichern der erweiterten Konfiguration:', err);
        alert(`Erweiterte Konfiguration konnte nicht gespeichert werden: ${err.message || 'Unbekannter Fehler'}`);
    }
};

async function loadAiConfig() {
    if (!isSuperAdminUser()) return;
    try {
        const response = await fetchWithAuth(`${config.apiBaseUrl}/admin/ai-config`);
        if (!response.ok) return;
        const data = await response.json();
        aiEnabled = !!data.enabled;
        const enabledEl = document.getElementById('super-admin-ai-enabled');
        if (enabledEl) enabledEl.checked = data.enabled;
        const baseUrlEl = document.getElementById('super-admin-ai-base-url');
        if (baseUrlEl) baseUrlEl.value = data.baseUrl || '';
        const apiKeyEl = document.getElementById('super-admin-ai-api-key');
        if (apiKeyEl) apiKeyEl.value = data.apiKey || '';
        const modelEl = document.getElementById('super-admin-ai-model');
        if (modelEl) modelEl.value = data.model || '';
        updateAiNavVisibility();
    } catch (err) {
        console.error('KI-Konfiguration konnte nicht geladen werden:', err);
    }
}

window.saveAiConfig = async () => {
    if (!isSuperAdminUser()) return;
    try {
        const payload = {
            enabled: document.getElementById('super-admin-ai-enabled')?.checked ?? false,
            baseUrl: document.getElementById('super-admin-ai-base-url')?.value.trim() || '',
            apiKey: document.getElementById('super-admin-ai-api-key')?.value || '',
            model: document.getElementById('super-admin-ai-model')?.value.trim() || ''
        };
        const response = await fetchWithAuth(`${config.apiBaseUrl}/admin/ai-config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${response.status}`);
        }
        aiEnabled = payload.enabled;
        updateAiNavVisibility();
        showToast('KI-Einstellungen gespeichert');
    } catch (err) {
        console.error('Fehler beim Speichern der KI-Einstellungen:', err);
        alert(`KI-Einstellungen konnten nicht gespeichert werden: ${err.message || 'Unbekannter Fehler'}`);
    }
};

function updateAiNavVisibility() {
    const show = aiEnabled && !!(currentUser && currentUser.admin);
    const bottomBtn = document.getElementById('admin-ai-nav-btn');
    const desktopBtn = document.getElementById('admin-ai-nav-btn-desktop');
    const spacer = document.getElementById('admin-nav-spacer');
    if (bottomBtn) bottomBtn.style.display = show ? '' : 'none';
    if (desktopBtn) desktopBtn.style.display = show ? '' : 'none';
    if (spacer) spacer.style.display = !show ? '' : 'none'; // Show spacer when AI is off to keep 5-item flex balanced (History is always right, so we need a spacer if AI is missing)
}

window.clearAiChat = () => {
    aiMessages = [];
    const messagesEl = document.getElementById('ai-chat-messages');
    if (!messagesEl) return;
    messagesEl.innerHTML = `
        <div class="ai-chat-welcome">
            <div class="ai-chat-welcome-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            </div>
            <div class="ai-chat-welcome-text">KI-Assistent bereit</div>
            <div class="ai-chat-welcome-sub">Stelle Fragen zu deinen Mitgliedern, Finanzen oder Einstellungen.</div>
        </div>`;
};

function adjustAiInputHeight(inputEl) {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, MAX_AI_CHAT_INPUT_HEIGHT)}px`;
}

window.handleAiChatInput = (event) => {
    if (!event || !event.target) return;
    adjustAiInputHeight(event.target);
};

window.handleAiChatKey = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendAiMessage();
    }
};

function appendAiMessage(role, content) {
    const messagesEl = document.getElementById('ai-chat-messages');
    if (!messagesEl) return null;

    // Remove welcome screen on first message
    const welcome = messagesEl.querySelector('.ai-chat-welcome');
    if (welcome) welcome.remove();

    const bubble = document.createElement('div');
    bubble.className = `ai-chat-bubble ai-chat-bubble-${role}`;
    if (role === 'assistant') {
        bubble.appendChild(renderMarkdown(content));
    } else {
        bubble.textContent = content;
    }
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
}

/**
 * Builds a collapsed <details> element for thinking/reasoning content.
 * All text is set via textContent to prevent XSS.
 */
function buildThinkingElement(thinkingText) {
    const details = document.createElement('details');
    details.className = 'ai-thinking';
    const summary = document.createElement('summary');
    summary.className = 'ai-thinking-summary';
    summary.textContent = 'Denkprozess anzeigen';
    const pre = document.createElement('pre');
    pre.className = 'ai-thinking-content';
    pre.textContent = thinkingText.trim();
    details.appendChild(summary);
    details.appendChild(pre);
    return details;
}

/**
 * Finalises an assistant bubble after streaming is complete.
 * Extracts <think>…</think> or <thought>…</thought> blocks, renders thinking dropdown + markdown body.
 */
function finalizeAssistantBubble(bubble, rawContent, reasoningContent) {
    if (!bubble) return;

    const existingDetails = bubble.querySelector('details.ai-thinking');
    const wasOpen = existingDetails ? existingDetails.open : false;

    // Extract <think>…</think> or <thought>…</thought> blocks from content (some models embed thinking inline)
    let thinkingFromContent = '';
    const mainContent = rawContent.replace(/<(?:think|thought)>([\s\S]*?)(?:<\/?(?:think|thought)>|$)/gi, (_, inner) => {
        thinkingFromContent += inner;
        return '';
    }).trim();

    const combinedThinking = (reasoningContent + thinkingFromContent).trim();

    bubble.replaceChildren();
    if (combinedThinking) {
        const thinkingEl = buildThinkingElement(combinedThinking);
        if (wasOpen) thinkingEl.open = true;
        bubble.appendChild(thinkingEl);
    }
    bubble.appendChild(renderMarkdown(mainContent));
}

/**
 * Lightweight Markdown → DOM fragment renderer for AI chat messages.
 * Uses DOM APIs exclusively (no innerHTML) to prevent XSS.
 * Handles: fenced code blocks, inline code, bold, italic, headers, lists, line breaks.
 */
function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    if (!text) return frag;

    // 1. Extract fenced code blocks to protect them from inline transforms
    const codeBlocks = [];
    const processed = text.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
        return `\x00CODE${idx}\x00`;
    });

    // 2. Process lines for block-level elements
    const lines = processed.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Unordered list
        if (/^[ \t]*[-*] /.test(line)) {
            const ul = document.createElement('ul');
            while (i < lines.length && /^[ \t]*[-*] /.test(lines[i])) {
                const li = document.createElement('li');
                appendInlineNodes(li, lines[i].replace(/^[ \t]*[-*] /, ''));
                ul.appendChild(li);
                i++;
            }
            frag.appendChild(ul);
            continue;
        }

        // Ordered list
        if (/^[ \t]*\d+\. /.test(line)) {
            const ol = document.createElement('ol');
            while (i < lines.length && /^[ \t]*\d+\. /.test(lines[i])) {
                const li = document.createElement('li');
                appendInlineNodes(li, lines[i].replace(/^[ \t]*\d+\. /, ''));
                ol.appendChild(li);
                i++;
            }
            frag.appendChild(ol);
            continue;
        }

        // Headers (# ## ###)
        const headingMatch = line.match(/^(#{1,3}) (.+)/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const el = document.createElement(`h${level}`);
            appendInlineNodes(el, headingMatch[2]);
            frag.appendChild(el);
            i++;
            continue;
        }

        // Tables
        if (/^[ \t]*\|/.test(line)) {
            const tableWrap = document.createElement('div');
            tableWrap.className = 'ai-table-wrapper';
            const table = document.createElement('table');
            const thead = document.createElement('thead');
            const tbody = document.createElement('tbody');
            let isFirstRow = true;

            while (i < lines.length && /^[ \t]*\|/.test(lines[i])) {
                const rowLine = lines[i].trim();

                // Skip separator rows like |:---|:---|
                if (/^[ \t]*\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/.test(rowLine)) {
                    i++;
                    isFirstRow = false;
                    continue;
                }

                const tr = document.createElement('tr');
                const cells = rowLine.split('|');

                // Remove empty first and last elements if the line starts/ends with |
                if (cells.length > 0 && cells[0].trim() === '') cells.shift();
                if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();

                for (const cell of cells) {
                    const cellEl = document.createElement(isFirstRow ? 'th' : 'td');
                    appendInlineNodes(cellEl, cell.trim());
                    tr.appendChild(cellEl);
                }

                if (isFirstRow) {
                    thead.appendChild(tr);
                    isFirstRow = false;
                } else {
                    tbody.appendChild(tr);
                }
                i++;
            }
            if (thead.childNodes.length > 0) table.appendChild(thead);
            if (tbody.childNodes.length > 0) table.appendChild(tbody);
            tableWrap.appendChild(table);
            frag.appendChild(tableWrap);
            continue;
        }

        // Horizontal rule
        if (/^---+$/.test(line.trim())) {
            frag.appendChild(document.createElement('hr'));
            i++;
            continue;
        }

        // Fenced code block placeholder
        const codeMatch = line.match(/^\x00CODE(\d+)\x00$/);
        if (codeMatch) {
            const { lang, code } = codeBlocks[parseInt(codeMatch[1], 10)];
            const pre = document.createElement('pre');
            pre.className = 'ai-code-block';
            const codeEl = document.createElement('code');
            if (lang) codeEl.className = `language-${lang}`;
            codeEl.textContent = code;
            pre.appendChild(codeEl);
            frag.appendChild(pre);
            i++;
            continue;
        }

        // Empty line → visual break
        if (line.trim() === '') {
            frag.appendChild(document.createElement('br'));
            i++;
            continue;
        }

        // Paragraph
        const p = document.createElement('p');
        appendInlineNodes(p, line);
        frag.appendChild(p);
        i++;
    }

    return frag;
}

/**
 * Parses inline markdown (bold, italic, inline code) and appends DOM nodes to parent.
 * Text nodes are created with createTextNode — no innerHTML, no XSS risk.
 */
function appendInlineNodes(parent, text) {
    // Split on inline patterns (backtick code, bold **, italic *)
    const parts = text.split(/(`[^`]+`|\*\*(?:.+?)\*\*|\*(?:[^*]+)\*)/);
    for (const part of parts) {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
            const code = document.createElement('code');
            code.className = 'ai-inline-code';
            code.textContent = part.slice(1, -1);
            parent.appendChild(code);
        } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
            const strong = document.createElement('strong');
            strong.textContent = part.slice(2, -2);
            parent.appendChild(strong);
        } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
            const em = document.createElement('em');
            em.textContent = part.slice(1, -1);
            parent.appendChild(em);
        } else {
            parent.appendChild(document.createTextNode(part));
        }
    }
}

window.sendAiMessage = async () => {
    if (aiStreaming) return;
    const inputEl = document.getElementById('ai-chat-input');
    const sendBtn = document.getElementById('ai-chat-send-btn');
    if (!inputEl) return;

    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = '';
    adjustAiInputHeight(inputEl);

    aiMessages.push({ role: 'user', content: text });
    appendAiMessage('user', text);

    aiStreaming = true;
    if (sendBtn) sendBtn.disabled = true;

    // Show typing indicator
    const messagesEl = document.getElementById('ai-chat-messages');
    const typingEl = document.createElement('div');
    typingEl.className = 'ai-chat-typing';
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    if (messagesEl) {
        messagesEl.appendChild(typingEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    let assistantBubble = null;
    let assistantContent = '';
    let reasoningContent = '';

    try {
        let token;
        try {
            token = await auth.currentUser.getIdToken();
        } catch {
            throw new Error('Authentifizierung fehlgeschlagen');
        }

        const response = await fetch(`${config.apiBaseUrl}/ai/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ messages: aiMessages })
        });

        if (typingEl.parentNode) typingEl.remove();

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${response.status}`);
        }

        assistantBubble = appendAiMessage('assistant', '');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') break;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.content) {
                        assistantContent += parsed.content;
                    }
                    if (parsed.reasoning) {
                        reasoningContent += parsed.reasoning;
                    }
                    if (assistantBubble) {
                        finalizeAssistantBubble(assistantBubble, assistantContent, reasoningContent);
                        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
                    }
                } catch { /* skip */ }
            }
        }

        // Re-render with markdown + optional thinking dropdown
        finalizeAssistantBubble(assistantBubble, assistantContent, reasoningContent);
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

        aiMessages.push({ role: 'assistant', content: assistantContent });
    } catch (err) {
        if (typingEl.parentNode) typingEl.remove();
        console.error('KI-Chat Fehler:', err);
        if (assistantBubble) {
            assistantBubble.textContent = `Fehler: ${err.message || 'Unbekannter Fehler'}`;
            assistantBubble.classList.add('ai-chat-bubble-error');
        } else {
            const errBubble = appendAiMessage('assistant', `Fehler: ${err.message || 'Unbekannter Fehler'}`);
            if (errBubble) errBubble.classList.add('ai-chat-bubble-error');
        }
        // Remove the failed user message from history so the user can retry
        if (aiMessages.length > 0 && aiMessages[aiMessages.length - 1].role === 'user') {
            aiMessages.pop();
        }
    } finally {
        aiStreaming = false;
        if (sendBtn) sendBtn.disabled = false;
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const inputEl = document.getElementById('ai-chat-input');
    if (inputEl) adjustAiInputHeight(inputEl);
});

window.uploadChurchLogo = async () => {
    if (!isSuperAdminUser()) return;
    const fileInput = document.getElementById('super-admin-logo-file');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        alert('Bitte eine SVG-Datei auswählen.');
        return;
    }

    const formData = new FormData();
    formData.append('logo', fileInput.files[0]);

    try {
        const response = await fetchWithAuth(`${config.apiBaseUrl}/admin/logo`, {
            method: 'POST',
            body: formData
        });

        let errorText = null;
        if (!response.ok) {
            // Clone the response before reading it, so we can fall back to text if json fails
            const responseClone = response.clone();
            try {
                const data = await response.json();
                if (data && data.error) {
                    errorText = data.error;
                } else if (data && Object.keys(data).length > 0) {
                    errorText = JSON.stringify(data);
                } else {
                    throw new Error("Empty JSON");
                }
            } catch (e) {
                errorText = await responseClone.text();
            }
            throw new Error(errorText || `HTTP ${response.status}`);
        }

        const cacheBust = `?v=${Date.now()}`;
        document.querySelectorAll("img[src*='church-logo.svg']").forEach((img) => {
            img.src = `assets/church-logo.svg${cacheBust}`;
        });
        fileInput.value = '';
        showToast('Logo aktualisiert');
    } catch (err) {
        const errMsg = err.message || err.code || 'Unbekannter Fehler';
        console.error('Fehler beim Logo-Upload:', errMsg, err);
        alert(`Logo konnte nicht aktualisiert werden: ${errMsg}`);
        showToast('Logo konnte nicht aktualisiert werden', 'error');
    }
};

window.saveSettings = async () => {
    settings.vollverdiener = parseFloat(document.getElementById('rate-vollverdiener').value.replace(',', '.'));
    settings.geringverdiener = parseFloat(document.getElementById('rate-geringverdiener').value.replace(',', '.'));
    settings.keinverdiener = parseFloat(document.getElementById('rate-keinverdiener').value.replace(',', '.'));
    settings.reportStartDate = document.getElementById('report-start-date').value || null;
    settingsVersion++;

    const emailNotifications = document.getElementById('admin-email-notifications').checked;

    try {
        await set(ref(db, 'settings'), settings);
        if (currentUser && currentUser.uid) {
            await update(ref(db, 'users/' + currentUser.uid), { emailNotifications });
            currentUser.emailNotifications = emailNotifications;
        }
        await renderAll();
        showToast("Einstellungen gespeichert");
    } catch (err) {
        console.error('Fehler beim Speichern der Einstellungen:', err);
        alert('Einstellungen konnten nicht gespeichert werden.');
    }
};

window.changePassword = async (isUser = false) => {
    const inputId = isUser ? 'user-new-password' : 'new-password';
    const oldInputId = isUser ? 'user-old-password' : 'old-password';
    const pw = document.getElementById(inputId).value;
    const oldPw = document.getElementById(oldInputId).value;

    if(!oldPw) {
        alert("Bitte geben Sie Ihr altes Passwort ein.");
        return;
    }

    if(!pw || pw.length < 6) {
        alert("Neues Passwort muss mindestens 6 Zeichen lang sein.");
        return;
    }

    try {
        const user = auth.currentUser;
        if(user) {
            await updatePassword(user, oldPw, pw);
            showToast("Passwort erfolgreich geändert");
            document.getElementById(inputId).value = '';
            document.getElementById(oldInputId).value = '';
        } else {
            alert("Kein Benutzer angemeldet.");
        }
    } catch (error) {
        console.error(error);
        alert("Fehler beim Ändern des Passworts: " + error.message);
    }
};

function replacePersonInMemory(person) {
    // ⚡ Bolt: Ensure data is optimized before storing
    preprocessPerson(person);
    const idx = people.findIndex(p => String(p.id) === String(person.id));
    if (idx >= 0) {
        if (person.isDeleted) {
            people.splice(idx, 1);
        } else {
            people[idx] = person;
        }
    } else {
        if (!person.isDeleted) {
            people.push(person);
        }
    }
}

async function mutatePerson(personId, mutator) {
    const personRef = ref(db, 'people/' + personId);
    const result = await runTransaction(personRef, (current) => {
        if (!current) return current;
        const draft = { ...current };
        draft.payments = safeList(draft.payments);
        draft.statusHistory = safeList(draft.statusHistory);
        return mutator(draft);
    });
    const updated = result.snapshot.val();
    if (updated) replacePersonInMemory(updated);
    return updated;
}

async function saveNewPerson(person) {
    if (!person || !person.id) throw new Error('Person ohne ID kann nicht gespeichert werden');
    await set(ref(db, 'people/' + person.id), person);
    replacePersonInMemory(person);
}

function initTheme() {
    const t = localStorage.getItem('nova-theme') || 'system';
    window.setTheme(t);

    // Listen for OS theme changes if 'system' is active
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        if (localStorage.getItem('nova-theme') === 'system') {
            applyActualTheme('system');
        }
    });
}

function applyActualTheme(t) {
    let actualTheme = t;
    if (t === 'system') {
        actualTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', actualTheme);
    document.querySelector('meta[name="theme-color"]').content = actualTheme === 'dark' ? '#0f172a' : '#06b6d4';
}

window.setTheme = (t) => {
    localStorage.setItem('nova-theme', t);
    applyActualTheme(t);

    // Update active button state
    document.querySelectorAll("button[onclick^='setTheme']").forEach(btn => {
        if (btn.getAttribute('onclick') === `setTheme('${t}')`) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
};

function setLoadingMessage(msg) {
    const el = document.getElementById('loading-message');
    if (el) el.textContent = msg;
}

async function fetchUserProfile(uid, retries = 2) {
    const snap = await get(ref(db, 'users/' + uid));
    if (snap.exists()) return { ...snap.val(), uid };
    if (retries > 0) {
        await new Promise(res => setTimeout(res, 400));
        return fetchUserProfile(uid, retries - 1);
    }
    return null;
}

async function bootstrapSuperAdmin(user) {
    try {
        const response = await fetchWithAuth(`${config.apiBaseUrl}/admin/bootstrap-super-admin`, {
            method: 'POST'
        });
        if (!response.ok) return;
        const result = await response.json();
        if (result.isSuperAdmin) {
            currentUser = {
                ...(currentUser || {}),
                admin: true,
                superAdmin: true
            };
            const freshProfile = await fetchUserProfile(user.uid, 2);
            if (freshProfile) currentUser = freshProfile;
        }
    } catch (error) {
        console.warn('Super admin bootstrap skipped:', error);
    }
}

// Auth Listener
onAuthStateChanged(auth, async (user) => {
    if (user) {
        // Ensure spinner is visible while fetching user profile
        const loader = document.getElementById('loading-overlay');
        if(loader) loader.style.display = 'flex';
        setLoadingMessage('Profil wird geladen...');

        localStorage.setItem('nova-is-logged-in', 'true');
        const profile = await fetchUserProfile(user.uid, 2);
        if(profile) {
            currentUser = profile;
        } else {
            setLoadingMessage('Profil nicht gefunden, bitte Admin kontaktieren.');
            currentUser = { role: 'user', email: user.email, uid: user.uid };
        }
        await bootstrapSuperAdmin(user);

        document.getElementById('login-modal').classList.remove('show');
        isAuthenticated = true;
        connectSSE();
        loadData();
        loadCurrentProfilePicture();
    } else {
        // Hide spinner if we are not logged in (e.g. session expired)
        const loader = document.getElementById('loading-overlay');
        if(loader) loader.style.display = 'none';

        localStorage.removeItem('nova-is-logged-in');
        isAuthenticated = false;
        advancedConfigLoaded = false;
        advancedConfigAppName = null;
        currentUser = null;
        document.getElementById('login-modal').classList.add('show');
        showLogin();
    }
});

function checkAuth() {
    // Initial check handled by onAuthStateChanged
}

window.logout = async () => {
    try {
        if (sseConnection) {
            sseConnection.close();
            sseConnection = null;
        }
        _applyProfilePicture(null);
        await signOut(auth);
    } catch (error) {
        console.error("Logout Error:", error);
    }
};

window.attemptLogin = async () => {
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-password').value;
    const errDiv = document.getElementById('auth-error');

    setButtonLoading('btn-login', true, "Anmelden...");

    if(!email || !pass) {
        errDiv.innerText = "Bitte E-Mail und Passwort eingeben.";
        errDiv.style.display = 'block';
        setButtonLoading('btn-login', false);
        return;
    }

    try {
        await signInWithEmailAndPassword(auth, email, pass);
        // Reset button state on success so it's ready for next login after logout
        setButtonLoading('btn-login', false);
    } catch (error) {
        console.error(error);
        errDiv.innerText = "Login fehlgeschlagen: " + error.message;
        errDiv.style.display = 'block';
        setButtonLoading('btn-login', false);
    }
};

window.attemptRegister = async () => {
    const code = document.getElementById('reg-code').value;
    const email = document.getElementById('reg-email').value;
    const first = document.getElementById('reg-firstname').value;
    const last = document.getElementById('reg-lastname').value;
    const p1 = document.getElementById('reg-pass1').value;
    const p2 = document.getElementById('reg-pass2').value;
    const errDiv = document.getElementById('auth-error');

    if(!code || !email || !first || !last || !p1 || !p2) {
        errDiv.innerText = "Bitte alle Felder ausfüllen.";
        errDiv.style.display = 'block';
        return;
    }
    if(p1.length < 6) {
        errDiv.innerText = "Passwort muss mindestens 6 Zeichen lang sein.";
        errDiv.style.display = 'block';
        return;
    }
    if(p1 !== p2) {
        errDiv.innerText = "Passwörter stimmen nicht überein.";
        errDiv.style.display = 'block';
        return;
    }

    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, p1, {
            inviteCode: code,
            firstName: first,
            lastName: last,
            name: `${first} ${last}`.trim()
        });
        const user = userCredential.user;
        // Persist basic user profile
        await set(ref(db, 'users/' + user.uid), {
            firstName: first,
            lastName: last,
            email,
            admin: false
        });

        errDiv.style.display = 'none';
        const loader = document.getElementById('loading-overlay');
        if(loader) loader.style.display = 'flex';
        setLoadingMessage('Profil wird initialisiert...');
        document.getElementById('login-modal').classList.remove('show');
    } catch (error) {
        console.error(error);
        if (error.message && error.message.includes('Ungültiger Registrierungscode')) {
            errDiv.innerText = "Ungültiger Registrierungscode.";
        } else {
            errDiv.innerText = "Registrierung fehlgeschlagen: " + error.message;
        }
        errDiv.style.display = 'block';
    }
};

let currentRequestType = null;

window.openUserRequestModal = (type) => {
    currentRequestType = type;
    const container = document.getElementById('req-form-content');
    const title = document.getElementById('req-modal-title');

    if(type === 'payment') {
        title.innerText = "Zahlung melden";
        container.innerHTML = `
            <div class="form-group" style="display:flex; align-items:center; gap:10px;">
                <label class="switch">
                    <input type="checkbox" id="req-is-standing-order" onchange="document.getElementById('req-date-label').innerText = this.checked ? 'Startdatum' : 'Datum'">
                    <span class="slider"></span>
                </label>
                <label for="req-is-standing-order" style="margin:0; font-weight:600; cursor:pointer">Dauerauftrag</label>
            </div>
            <div class="form-group">
                <label class="form-label" for="req-amount">Betrag (€)</label>
                <input type="text" inputmode="decimal" id="req-amount" class="form-input">
            </div>
            <div class="form-group">
                <label class="form-label" id="req-date-label" for="req-date">Datum</label>
                <input type="date" id="req-date" class="form-input" value="${new Date().toISOString().split('T')[0]}">
            </div>
            <div class="form-group">
                <label class="form-label" for="req-note">Notiz (Optional)</label>
                <input type="text" id="req-note" class="form-input">
            </div>
        `;
    } else if(type === 'status') {
        title.innerText = "Statusänderung beantragen";
        container.innerHTML = `
            <div class="form-group">
                <label class="form-label" for="req-status">Neuer Status</label>
                <select id="req-status" class="form-select">
                    <option value="vollverdiener">💼 Vollverdiener</option>
                    <option value="geringverdiener">📉 Geringverdiener</option>
                    <option value="keinverdiener">🎓 Keinverdiener</option>
                    <option value="pausiert">⏸️ Pausiert</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label" for="req-date">Gültig ab</label>
                <input type="date" id="req-date" class="form-input" value="${new Date().toISOString().split('T')[0]}">
            </div>
        `;
    } else if(type === 'expense') {
        title.innerText = "Ausgabe melden";
        container.innerHTML = `
            <div class="form-group">
                <label class="form-label" for="req-amount">Betrag (€)</label>
                <input type="text" inputmode="decimal" id="req-amount" class="form-input">
            </div>
            <div class="form-group">
                <label class="form-label" for="req-desc">Beschreibung</label>
                <input type="text" id="req-desc" class="form-input">
            </div>
            <div class="form-group">
                <label class="form-label" for="req-date">Datum</label>
                <input type="date" id="req-date" class="form-input" value="${new Date().toISOString().split('T')[0]}">
            </div>
            <div class="form-group">
                <label class="form-label" for="req-receipt">Beleg (Optional)</label>
                <input type="file" id="req-receipt" accept="image/*,.heic,.heif" class="form-input">
            </div>
        `;
    }

    openModal('user-request-modal');
};

window.submitUserRequest = async () => {
    if(!currentUser) return;

    // Find person ID linked to current user
    const person = people.find(p => p.uid === currentUser.uid);
    if(!person) { alert("Kein Personenprofil gefunden."); return; }

    const reqData = {};
    const date = document.getElementById('req-date').value;

    if(currentRequestType === 'payment') {
        const amount = document.getElementById('req-amount').value.replace(',', '.');
        const note = document.getElementById('req-note').value;
        const isStandingOrder = document.getElementById('req-is-standing-order') && document.getElementById('req-is-standing-order').checked;

        if(!amount || !date) { alert("Bitte alle Felder ausfüllen"); return; }
        if(isNaN(parseFloat(amount))) { alert("Ungültiger Betrag"); return; }

        reqData.amount = amount;
        reqData.date = date;
        reqData.note = note;

        if (isStandingOrder) {
            currentRequestType = 'standing_order';
        }
    } else if(currentRequestType === 'status') {
        const status = document.getElementById('req-status').value;
        if(!status || !date) { alert("Bitte alle Felder ausfüllen"); return; }
        reqData.newStatus = status;
        reqData.date = date;
    } else if(currentRequestType === 'expense') {
        const amount = document.getElementById('req-amount').value.replace(',', '.');
        const desc = document.getElementById('req-desc').value;
        if(!amount || !desc || !date) { alert("Bitte alle Felder ausfüllen"); return; }
        reqData.amount = amount;
        reqData.description = desc;
        reqData.date = date;

        const fileInput = document.getElementById('req-receipt');
        if (fileInput && fileInput.files.length > 0) {
             setButtonLoading('btn-submit-request', true, "Lade hoch...");
             try {
                reqData.receipt = await uploadReceipt(fileInput.files[0], person.name, date);
             } catch(err) {
                 alert("Fehler beim Hochladen: " + err.message);
                 setButtonLoading('btn-submit-request', false);
                 return;
             }
        }
    }

    const newReq = {
        id: Date.now().toString(),
        type: currentRequestType,
        userId: currentUser.uid,
        personId: person.id,
        personName: person.name,
        data: reqData,
        status: 'pending',
        timestamp: Date.now()
    };

    setButtonLoading('btn-submit-request', true, "Sende...");

    try {
        await set(ref(db, 'requests/' + newReq.id), newReq);
        closeModal('user-request-modal');
        showToast("Anfrage erfolgreich gesendet");
        loadData();

        // Notify opted-in admins using the backend endpoint to avoid frontend permission denied errors
        try {
            const token = await auth.currentUser.getIdToken();
            await fetch(`${config.apiBaseUrl}/notify-admins`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ reqType: currentRequestType, personName: person.name })
            }).catch(e => console.warn("Fehler beim Senden der Admin-Info über Backend", e));
        } catch (e) {
            console.warn("Konnte Admins nicht benachrichtigen:", e);
        }

    } catch (err) {
        console.error('Fehler beim Senden der Anfrage:', err);
        alert('Anfrage konnte nicht gesendet werden. Bitte erneut versuchen.');
    } finally {
        setButtonLoading('btn-submit-request', false);
    }
};

window.generateNewCode = async () => {
    const array = new Uint32Array(1);
    window.crypto.getRandomValues(array);
    const newCode = 100000 + (array[0] % 900000);
    try {
        await set(ref(db, 'system/inviteCode'), newCode);
        document.getElementById('admin-invite-code').value = newCode;
    } catch (err) {
        console.error('Fehler beim Generieren des Codes:', err);
        alert('Neuer Code konnte nicht gespeichert werden.');
    }
};

// --- Node.js Backend Receipt Handling ---

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 10000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// Profile picture: crop state
let _profileCropDataUrl = null;
let _profileCropContext = null; // { imgEl, naturalW, naturalH, cropSize, offsetX, offsetY, isDragging, dragStartX, dragStartY, source }

function _profileCropClamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

window.openProfileCrop = async function(input, source) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    // HEIC/HEIF conversion using existing heic2any
    let imageFile = file;
    const isHeic = file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
    if (isHeic) {
        try {
            const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
            const convertedBlob = Array.isArray(blob) ? blob[0] : blob;
            imageFile = new File([convertedBlob], file.name.replace(/\.hei[cf]$/i, '.jpg'), { type: 'image/jpeg' });
        } catch (e) {
            console.error('HEIC conversion failed:', e);
        }
    }

    // Use FileReader to produce a data: URL (guaranteed safe scheme, no XSS risk)
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(imageFile);
    });
    _profileCropDataUrl = dataUrl;

    const viewport = document.getElementById('profileCropViewport');
    const imgEl = document.getElementById('profileCropImage');
    const overlay = document.getElementById('profileCropOverlay');

    imgEl.src = _profileCropDataUrl;
    await new Promise(resolve => { imgEl.onload = resolve; });

    const vw = viewport.clientWidth || 360;
    const vh = Math.round(vw * 0.75);
    viewport.style.height = vh + 'px';

    const nw = imgEl.naturalWidth;
    const nh = imgEl.naturalHeight;

    // Scale image to fit inside viewport
    const scale = Math.min(vw / nw, vh / nh);
    let currentZoom = 1;

    function applyZoom() {
        const dispW = Math.round(nw * scale * currentZoom);
        const dispH = Math.round(nh * scale * currentZoom);
        imgEl.style.width = dispW + 'px';
        imgEl.style.height = dispH + 'px';
        imgEl.style.position = 'absolute';

        // Keep image centered
        imgEl.style.left = Math.round((vw - dispW) / 2) + 'px';
        imgEl.style.top = Math.round((vh - dispH) / 2) + 'px';

        // Constrain overlay within new image bounds
        const imgL = parseInt(imgEl.style.left);
        const imgT = parseInt(imgEl.style.top);
        offsetX = _profileCropClamp(offsetX, imgL, imgL + dispW - cropSize);
        offsetY = _profileCropClamp(offsetY, imgT, imgT + dispH - cropSize);
        overlay.style.left = offsetX + 'px';
        overlay.style.top = offsetY + 'px';
    }

    const cropSize = Math.min(Math.round(nw * scale), Math.round(nh * scale), Math.min(vw, vh) - 20);
    overlay.style.width = cropSize + 'px';
    overlay.style.height = cropSize + 'px';

    let offsetX = Math.round((vw - cropSize) / 2);
    let offsetY = Math.round((vh - cropSize) / 2);

    applyZoom();

    let isDragging = false, dragStartX = 0, dragStartY = 0, dragStartOX = 0, dragStartOY = 0;

    function onPointerDown(e) {
        e.preventDefault();
        isDragging = true;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        dragStartX = clientX; dragStartY = clientY;
        dragStartOX = offsetX; dragStartOY = offsetY;
    }
    function onPointerMove(e) {
        if (!isDragging) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const imgL = parseInt(imgEl.style.left);
        const imgT = parseInt(imgEl.style.top);
        const dispW = Math.round(nw * scale * currentZoom);
        const dispH = Math.round(nh * scale * currentZoom);
        offsetX = _profileCropClamp(dragStartOX + (clientX - dragStartX), imgL, imgL + dispW - cropSize);
        offsetY = _profileCropClamp(dragStartOY + (clientY - dragStartY), imgT, imgT + dispH - cropSize);
        overlay.style.left = offsetX + 'px';
        overlay.style.top = offsetY + 'px';
    }
    function onPointerUp() { isDragging = false; }

    overlay.removeEventListener('mousedown', overlay._md);
    overlay.removeEventListener('touchstart', overlay._td);
    overlay._md = onPointerDown; overlay._td = onPointerDown;
    overlay.addEventListener('mousedown', overlay._md);
    overlay.addEventListener('touchstart', overlay._td, { passive: false });
    document.removeEventListener('mousemove', overlay._mm);
    document.removeEventListener('mouseup', overlay._mu);
    document.removeEventListener('touchmove', overlay._tm);
    document.removeEventListener('touchend', overlay._tu);
    overlay._mm = onPointerMove; overlay._mu = onPointerUp;
    overlay._tm = onPointerMove; overlay._tu = onPointerUp;
    document.addEventListener('mousemove', overlay._mm);
    document.addEventListener('mouseup', overlay._mu);
    document.addEventListener('touchmove', overlay._tm, { passive: false });
    document.addEventListener('touchend', overlay._tu);

    // Zoom slider logic
    const zoomSlider = document.getElementById('profileCropZoom');
    if (zoomSlider) {
        zoomSlider.value = 1;

        zoomSlider.removeEventListener('input', zoomSlider._zl);
        zoomSlider._zl = function(e) {
            currentZoom = parseFloat(e.target.value);
            applyZoom();
        };
        zoomSlider.addEventListener('input', zoomSlider._zl);
    }

    // Mouse wheel zoom logic
    viewport.removeEventListener('wheel', viewport._wl);
    viewport._wl = function(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        currentZoom = _profileCropClamp(currentZoom + delta, 1, 3);
        if (zoomSlider) zoomSlider.value = currentZoom;
        applyZoom();
    };
    viewport.addEventListener('wheel', viewport._wl, { passive: false });

    _profileCropContext = {
        imgEl, nw, nh,
        get dispW() { return Math.round(nw * scale * currentZoom); },
        get dispH() { return Math.round(nh * scale * currentZoom); },
        get imgLeft() { return parseInt(imgEl.style.left); },
        get imgTop() { return parseInt(imgEl.style.top); },
        cropSize, vw, vh,
        getOffset: () => ({ x: offsetX, y: offsetY }),
        source
    };

    openModal('profile-crop-modal');
};

window.cancelProfileCrop = function() {
    _profileCropDataUrl = null;
    _profileCropContext = null;
    closeModal('profile-crop-modal');
};

window.confirmProfileCrop = async function() {
    const ctx = _profileCropContext;
    if (!ctx) return;

    const { imgEl, nw, nh, dispW, dispH, imgLeft, imgTop, cropSize, getOffset, source } = ctx;
    const { x: offsetX, y: offsetY } = getOffset();

    // Crop relative to displayed image
    const relX = offsetX - imgLeft;
    const relY = offsetY - imgTop;
    const scaleX = nw / dispW;
    const scaleY = nh / dispH;
    const srcX = Math.round(relX * scaleX);
    const srcY = Math.round(relY * scaleY);
    const srcSize = Math.round(cropSize * Math.min(scaleX, scaleY));

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const c = canvas.getContext('2d');
    c.drawImage(imgEl, srcX, srcY, srcSize, srcSize, 0, 0, 256, 256);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) { showToast('Fehler beim Verarbeiten des Bildes.', 'error'); return; }

    const jpegFile = new File([blob], 'profile.jpg', { type: 'image/jpeg' });

    setButtonLoading('btn-confirm-crop', true, 'Speichern...');
    try {
        await uploadProfilePicture(jpegFile);
        closeModal('profile-crop-modal');
        _profileCropDataUrl = null;
        showToast('Profilbild gespeichert!', 'success');
        await loadCurrentProfilePicture();
    } catch (e) {
        console.error('Profile upload error:', e);
        showToast('Fehler beim Hochladen: ' + e.message, 'error');
    } finally {
        setButtonLoading('btn-confirm-crop', false, null);
    }
};

async function uploadProfilePicture(jpegFile) {
    const formData = new FormData();
    formData.append('picture', jpegFile);
    const response = await fetchWithAuth(`${config.apiBaseUrl}/profile/picture`, {
        method: 'POST',
        body: formData
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Upload fehlgeschlagen');
    }
}

async function loadCurrentProfilePicture() {
    if (!currentUser) return;
    const uid = currentUser.uid || currentUser.id;
    if (!uid) return;
    try {
        const response = await fetchWithAuth(`${config.apiBaseUrl}/profile/picture/${encodeURIComponent(uid)}`);
        if (response.ok) {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            _applyProfilePicture(url);
        } else {
            _applyProfilePicture(null);
        }
    } catch {
        _applyProfilePicture(null);
    }
}

let _profilePicCache = new Map();
let _profilePicFetches = new Map();

async function getProfilePicUrl(uid) {
    if (!uid) return null;

    // Check if already fetched and cached
    if (_profilePicCache.has(uid)) {
        return _profilePicCache.get(uid);
    }

    // If currently fetching, wait for that fetch to complete
    if (_profilePicFetches.has(uid)) {
        return await _profilePicFetches.get(uid);
    }

    // Start a new fetch
    const fetchPromise = (async () => {
        try {
            const response = await fetchWithAuth(`${config.apiBaseUrl}/profile/picture/${encodeURIComponent(uid)}`);
            if (response.ok) {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                _profilePicCache.set(uid, url);
                return url;
            }
        } catch (err) {
            // ignore
        }
        _profilePicCache.set(uid, null);
        return null;
    })();

    _profilePicFetches.set(uid, fetchPromise);
    const result = await fetchPromise;
    _profilePicFetches.delete(uid);
    return result;
}

let _profilePictureObjectUrl = null;

function _applyProfilePicture(url) {
    if (_profilePictureObjectUrl) {
        URL.revokeObjectURL(_profilePictureObjectUrl);
        _profilePictureObjectUrl = null;
    }
    if (url) _profilePictureObjectUrl = url;

    const adminPreview = document.getElementById('admin-profile-pic-preview');
    const adminPlaceholder = document.getElementById('admin-profile-pic-placeholder');
    const userPreview = document.getElementById('user-profile-pic-preview');
    const userPlaceholder = document.getElementById('user-profile-pic-placeholder');
    const headerPic = document.getElementById('header-profile-pic');
    const headerIcon = document.getElementById('header-profile-icon');

    if (url) {
        if (adminPreview) { adminPreview.src = url; adminPreview.style.display = ''; }
        if (adminPlaceholder) adminPlaceholder.style.display = 'none';
        if (userPreview) { userPreview.src = url; userPreview.style.display = ''; }
        if (userPlaceholder) userPlaceholder.style.display = 'none';
        if (headerPic) { headerPic.src = url; headerPic.style.display = ''; }
        if (headerIcon) headerIcon.style.display = 'none';
    } else {
        if (adminPreview) adminPreview.style.display = 'none';
        if (adminPlaceholder) adminPlaceholder.style.display = '';
        if (userPreview) userPreview.style.display = 'none';
        if (userPlaceholder) userPlaceholder.style.display = '';
        if (headerPic) headerPic.style.display = 'none';
        if (headerIcon) headerIcon.style.display = '';
    }
}

async function compressImage(file, quality) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = event => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                let newName = file.name;
                if (!newName.toLowerCase().endsWith('.jpg') && !newName.toLowerCase().endsWith('.jpeg')) {
                    newName = newName.replace(/\.[^/.]+$/, "") + ".jpg";
                }

                canvas.toBlob(blob => {
                    if (blob) {
                        resolve(new File([blob], newName, { type: 'image/jpeg' }));
                    } else {
                        reject(new Error('Canvas to Blob failed'));
                    }
                }, 'image/jpeg', quality);
            };
            img.onerror = error => reject(error);
        };
        reader.onerror = error => reject(error);
    });
}

window.uploadReceipt = async function(file, transactionName, transactionDate) {
    const user = auth.currentUser;
    if (!user) throw new Error('Not authenticated');
    
    // Grab the active user's auth token to prove their identity
    const token = await user.getIdToken();
    const formData = new FormData();

    // 1. Append text fields FIRST
    if (transactionName) formData.append('name', transactionName);
    if (transactionDate) formData.append('date', transactionDate);

    // Check if it's HEIC/HEIF and convert
    let uploadFile = file;
    const isHeic = file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
    if (isHeic) {
        try {
            const blob = await heic2any({
                blob: file,
                toType: "image/jpeg",
                quality: 0.8
            });
            // heic2any can return an array of blobs or a single blob
            const convertedBlob = Array.isArray(blob) ? blob[0] : blob;
            const newName = file.name.replace(/\.hei[cf]$/i, '.jpg');
            uploadFile = new File([convertedBlob], newName, { type: "image/jpeg" });
        } catch (e) {
            console.error("HEIC conversion failed:", e);
            // fallback to uploading original if conversion fails
        }
    }

    // 1.5. Apply image compression based on size
    if (uploadFile.type.startsWith('image/') && uploadFile.type !== 'image/gif' && uploadFile.type !== 'image/svg+xml') {
        const sizeBytes = uploadFile.size;
        if (sizeBytes > 2 * 1024 * 1024) {
            try { uploadFile = await compressImage(uploadFile, 0.65); } catch (e) { console.error("Compression failed:", e); }
        } else if (sizeBytes >= 500 * 1024) {
            try { uploadFile = await compressImage(uploadFile, 0.75); } catch (e) { console.error("Compression failed:", e); }
        }
    }

    // 2. Append the file LAST
    formData.append('receipt', uploadFile);

    const url = `${config.apiBaseUrl}/upload`;

    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });

        if (!response.ok) {
            throw new Error('Upload failed: ' + response.statusText);
        }

        const data = await response.json();
        return data.filename;
    } catch (error) {
        console.error('Upload error:', error);
        throw error;
    }
};


window.fetchReceiptImage = async function(filename) {
    const user = auth.currentUser;
    if (!user) throw new Error('Not authenticated');
    
    const token = await user.getIdToken();
    const url = `${config.apiBaseUrl}/receipts/${encodeURIComponent(filename)}`;

    try {
        const response = await fetchWithTimeout(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            throw new Error('Fetch failed: ' + response.statusText);
        }

        // Convert the returned file into an object URL for the <img> tag
        let blob = await response.blob();

        // If the filename indicates it's a HEIC file, try to convert it for display
        const isHeic = filename.toLowerCase().endsWith('.heic') || filename.toLowerCase().endsWith('.heif') || blob.type === 'image/heic' || blob.type === 'image/heif';
        if (isHeic) {
            try {
                const converted = await heic2any({
                    blob: blob,
                    toType: "image/jpeg",
                    quality: 0.8
                });
                blob = Array.isArray(converted) ? converted[0] : converted;
            } catch (e) {
                console.error("HEIC fetch conversion failed:", e);
                // Just use the original blob if it fails, though it might not display
            }
        }

        return URL.createObjectURL(blob);
    } catch (error) {
        console.error('Fetch image error:', error);
        throw error;
    }
};

window.viewRequestReceipt = async function(filename, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Revoke previous URL if any
    if (container.dataset.blobUrl) {
        URL.revokeObjectURL(container.dataset.blobUrl);
        delete container.dataset.blobUrl;
    }

    container.innerHTML = '<div class="spinner" style="margin:10px auto;"></div><div style="text-align:center; font-size:0.8rem; color:var(--text-secondary);">Lade Beleg...</div>';

    try {
        const imgUrl = await fetchReceiptImage(filename);
        container.dataset.blobUrl = imgUrl;
        container.innerHTML = `
                <img src="${imgUrl}" style="width:100%; max-width:100%; border-radius:8px; border:1px solid var(--border); margin-top:10px; opacity:0; transition:opacity 0.3s ease-in;" onload="this.style.opacity=1" alt="Beleg">
        `;
    } catch (err) {
        console.error(err);
        container.innerHTML = `<div style="color:var(--danger); font-size:0.8rem; margin-top:10px;">Fehler beim Laden des Belegs.</div>`;
    }
};

window.findTransaction = function(id, type) {
    if (!cachedTransactions || cachedTransactions.length === 0) return null;

    const item = cachedTransactions.find(x => String(x.id) === String(id));
    if (!item) return null;

    if (type === 'exp') {
        return { ...item, typeName: 'Ausgabe' };
    } else if (type === 'don') {
        return { ...item, typeName: 'Spende', who: item.name || item.who };
    } else if (type === 'pay') {
        return { ...item, typeName: 'Zahlung' };
    }
    return null;
};

window.showTransactionDetails = async function(id, type) {
    const item = window.findTransaction(id, type);
    if (!item) return;

    // Hide the list visually without modifying the stack
    const listModal = document.getElementById('transaction-modal');
    if (listModal) listModal.classList.remove('show');

    openModal('transaction-details-modal');
    const content = document.getElementById('transaction-details-content');

    // Revoke previous URL if any
    if (content.dataset.blobUrl) {
         URL.revokeObjectURL(content.dataset.blobUrl);
         delete content.dataset.blobUrl;
    }

    let html = `
        <div style="text-align:center; margin-bottom:20px;">
            <div style="font-size:2rem; font-weight:800;">${formatCurrency(item.amount)} €</div>
            <div style="color:var(--text-secondary);">${item.typeName}</div>
        </div>
        <div class="details-status-card" style="background:var(--surface-alt); border:1px solid var(--border);">
            <div class="details-row">
                <span class="details-label">Datum</span>
                <span class="details-value">${item.date ? formatDateFast(item.date) : '-'}</span>
            </div>
            ${item.who ? `
            <div class="details-row">
                <span class="details-label">Person</span>
                <span class="details-value">${escapeHtml(item.who)}</span>
            </div>` : ''}
             ${item.issuer ? `
            <div class="details-row">
                <span class="details-label">Ausgestellt von</span>
                <span class="details-value">${escapeHtml(item.issuer)}</span>
            </div>` : ''}
            <div class="details-row">
                <span class="details-label">Beschreibung</span>
                <span class="details-value">${escapeHtml(item.description || item.note || '-')}</span>
            </div>
        </div>
        <div id="receipt-container" style="margin-top:20px;"></div>
    `;

    content.innerHTML = html;

    if (item.receipt) {
        const receiptContainer = document.getElementById('receipt-container');
        receiptContainer.innerHTML = '<div class="spinner" style="margin:20px auto;"></div><div style="text-align:center">Lade Beleg...</div>';

        try {
            const imgUrl = await fetchReceiptImage(item.receipt);
            content.dataset.blobUrl = imgUrl;
            receiptContainer.innerHTML = `
                <div style="font-weight:600; margin-bottom:10px;">Beleg</div>
                <img src="${imgUrl}" style="width:100%; border-radius:12px; border:1px solid var(--border); opacity:0; transition:opacity 0.3s ease-in;" onload="this.style.opacity=1" alt="Beleg">
            `;
        } catch (err) {
            receiptContainer.innerHTML = `<div style="color:var(--danger); text-align:center;">Beleg konnte nicht geladen werden.</div>`;
        }
    } else {
        document.getElementById('receipt-container').innerHTML = `<div style="color:var(--text-secondary); text-align:center; font-size:0.9rem;">Kein Beleg vorhanden.</div>`;
    }
};

// --- PWA Install Logic ---
let deferredPrompt;
const installBtn = document.getElementById('install-pwa-btn');

window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    // Stash the event so it can be triggered later.
    deferredPrompt = e;
    // Update UI notify the user they can install the PWA
    if (installBtn) {
        installBtn.style.display = 'inline-flex';
    }
});

if (installBtn) {
    installBtn.addEventListener('click', async () => {
        // Hide the app provided install promotion
        installBtn.style.display = 'none';
        // Show the install prompt
        if (deferredPrompt) {
            deferredPrompt.prompt();
            // Wait for the user to respond to the prompt
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`User response to the install prompt: ${outcome}`);
            // We've used the prompt, and can't use it again, throw it away
            deferredPrompt = null;
        }
    });
}

window.addEventListener('appinstalled', () => {
    // Hide the app-provided install promotion
    if (installBtn) installBtn.style.display = 'none';
    // Clear the deferredPrompt so it can be garbage collected
    deferredPrompt = null;
    console.log('PWA was installed');
});

let toastTimeout;
window.showToast = (msg, type='success') => {
    let t = document.getElementById('toast');
    if(!t) {
        t = document.createElement('div');
        t.id = 'toast';
        t.setAttribute('role', 'status');
        t.setAttribute('aria-live', 'polite');
        document.body.appendChild(t);
    }
    t.className = `toast toast-${type} show`;
    t.innerHTML = `${type==='success'?'✅':'⚠️'} ${msg}`;

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => t.classList.remove('show'), 3000);
};

window.copyInviteCode = async () => {
    const codeInput = document.getElementById('admin-invite-code');
    if (!codeInput || !codeInput.value) return;

    try {
        await navigator.clipboard.writeText(codeInput.value);
        showToast("Code kopiert!");
    } catch (err) {
        console.error("Copy failed", err);
        showToast("Kopieren fehlgeschlagen", "error");
    }
};

// Password Toggle
window.togglePassword = function(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    const eyeOff = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
    const eye = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    btn.innerHTML = isPassword ? eyeOff : eye;
    btn.setAttribute('aria-label', isPassword ? 'Passwort verbergen' : 'Passwort anzeigen');
};
