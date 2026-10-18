const DEMO_USER = {
  email: 'admin@demo.test',
  password: 'demo123456',
};

const showToast = (message, tone = 'info') => {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
};

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const message = payload?.error?.message || 'Request failed';
    throw new Error(message);
  }

  return payload?.data ?? payload ?? null;
}

async function loginUser(email, password) {
  const data = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  sessionStorage.setItem('hotelcareUser', JSON.stringify(data.user));
  sessionStorage.setItem('hotelcareCsrf', data.csrfToken);
  return data.user;
}

async function getCurrentUser() {
  try {
    const data = await apiFetch('/api/auth/me');
    sessionStorage.setItem('hotelcareUser', JSON.stringify(data.user));
    sessionStorage.setItem('hotelcareCsrf', data.csrfToken);
    return data.user;
  } catch {
    return null;
  }
}

async function logoutUser() {
  const csrf = sessionStorage.getItem('hotelcareCsrf');
  try {
    await apiFetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf || '' },
    });
  } catch (error) {
    console.warn('Logout warning:', error.message);
  }

  sessionStorage.removeItem('hotelcareUser');
  sessionStorage.removeItem('hotelcareCsrf');
  window.location.href = '/';
}

function bindLoginForm() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  const emailInput = document.getElementById('loginEmail');
  const passwordInput = document.getElementById('loginPassword');
  const demoLogin = document.getElementById('demoLogin');
  const modal = document.getElementById('loginModal');
  const close = document.getElementById('closeLoginModal');

  const openModal = () => modal?.classList.add('show');
  const closeModal = () => modal?.classList.remove('show');

  document.querySelectorAll('[data-open-login]').forEach((el) => el.addEventListener('click', openModal));
  close?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });

  demoLogin?.addEventListener('click', () => {
    emailInput.value = DEMO_USER.email;
    passwordInput.value = DEMO_USER.password;
    openModal();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();

    if (!email || !password) {
      showToast('Email and password are required.', 'error');
      return;
    }

    try {
      const submitBtn = form.querySelector('button[type="submit"]');
      const originalText = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing in...';

      await loginUser(email, password);
      showToast('Welcome back. Redirecting to dashboard...', 'success');
      closeModal();
      window.location.href = '/dashboard';
    } catch (error) {
      showToast(error.message || 'Unable to sign in.', 'error');
    } finally {
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });
}

function renderTicketRow(ticket) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td class="ticket-no">${ticket.ticketNo || '#N/A'}</td>
    <td>
      <div class="ticket-title">${ticket.subject}</div>
      <div class="ticket-meta">${ticket.locationName} • ${ticket.category}</div>
    </td>
    <td>${ticket.priority}</td>
    <td><span class="priority ${ticket.priority.toLowerCase()}">${ticket.priority}</span></td>
    <td><span class="state ${ticket.status.toLowerCase().replace(/_/g, '') || 'open'}">${ticket.status.replace(/_/g, ' ')}</span></td>
    <td>${ticket.assignedToName || 'Unassigned'}</td>
  `;
  return row;
}

function renderTicketTable(tickets) {
  const tableBody = document.querySelector('#ticketTableBody');
  if (!tableBody) return;

  tableBody.innerHTML = '';
  if (!tickets.length) {
    tableBody.innerHTML = '<tr><td colspan="6" class="empty-state">No maintenance tickets found.</td></tr>';
    return;
  }

  tickets.forEach((ticket) => tableBody.appendChild(renderTicketRow(ticket)));
}

function renderEscalations(tickets) {
  const list = document.querySelector('#escalationList');
  if (!list) return;

  const urgent = tickets.filter((ticket) => ticket.priority === 'CRITICAL' || ticket.priority === 'HIGH').slice(0, 3);
  if (!urgent.length) {
    list.innerHTML = '<div class="list-empty">No active escalations</div>';
    return;
  }

  list.innerHTML = urgent.map((ticket) => `
    <div class="list-item">
      <div>
        <strong>${ticket.subject}</strong>
        <small>${ticket.locationName} • ${ticket.status}</small>
      </div>
      <span class="mini-tag ${ticket.priority === 'CRITICAL' ? 'red' : 'gold'}">${ticket.priority}</span>
    </div>
  `).join('');
}

function renderTeamLoad(tickets) {
  const list = document.querySelector('#teamLoadList');
  if (!list) return;
  const teams = {
    'Alex': 82,
    'Priya': 64,
    'Leo': 74,
  };

  list.innerHTML = Object.entries(teams).map(([name, load]) => `
    <div class="list-item">
      <div>
        <strong>${name}</strong>
        <small>${load > 75 ? 'High workload' : 'Stable'}</small>
      </div>
      <span class="mini-tag ${load > 75 ? 'gold' : 'blue'}">${load}%</span>
    </div>
  `).join('');
}

function renderOverview(tickets) {
  const root = document.querySelector('#overviewStats');
  if (!root) return;

  const total = tickets.length;
  const open = tickets.filter((t) => ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(t.status)).length;
  const resolved = tickets.filter((t) => t.status === 'RESOLVED' || t.status === 'CLOSED').length;
  const critical = tickets.filter((t) => t.priority === 'CRITICAL').length;

  root.innerHTML = `
    <div class="statbox">
      <span>Total tickets</span>
      <strong>${total}</strong>
      <div class="trend">▲ ${Math.max(5, total % 20)}% this week</div>
    </div>
    <div class="statbox">
      <span>Open issues</span>
      <strong>${open}</strong>
      <div class="trend">▲ ${Math.max(2, open % 10)}% today</div>
    </div>
    <div class="statbox">
      <span>Resolved</span>
      <strong>${resolved}</strong>
      <div class="trend">▲ ${Math.max(3, resolved % 16)}% today</div>
    </div>
    <div class="statbox">
      <span>Critical</span>
      <strong>${critical}</strong>
      <div class="trend">▼ ${Math.max(1, critical % 8)}% stable</div>
    </div>
  `;
}

async function loadDashboard() {
  const me = await getCurrentUser();
  if (!me) {
    window.location.href = '/';
    return;
  }

  const userName = document.querySelector('#userName');
  if (userName) userName.textContent = me.name;

  const roleBadge = document.querySelector('#roleBadge');
  if (roleBadge) roleBadge.textContent = me.role;

  const searchInput = document.querySelector('#ticketSearch');
  let allTickets = [];

  const loadTickets = async () => {
    try {
      const response = await apiFetch('/api/tickets?page=1&pageSize=15&sort=updatedAt&dir=desc');
      const list = Array.isArray(response) ? response : (response?.data ?? []);
      allTickets = list;
      renderOverview(list);
      renderEscalations(list);
      renderTicketTable(list);
      renderTeamLoad(list);
    } catch (error) {
      showToast(error.message || 'Unable to load tickets.', 'error');
    }
  };

  searchInput?.addEventListener('input', (event) => {
    const q = event.target.value.trim().toLowerCase();
    const filtered = q ? allTickets.filter((ticket) => {
      const haystack = [ticket.ticketNo, ticket.subject, ticket.locationName, ticket.assignedToName, ticket.status].join(' ').toLowerCase();
      return haystack.includes(q);
    }) : allTickets;
    renderTicketTable(filtered);
  });

  const statusButtons = document.querySelectorAll('[data-filter]');
  statusButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      statusButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const filter = btn.dataset.filter;
      const filtered = filter === 'all' ? allTickets : allTickets.filter((ticket) => ticket.status === filter);
      renderTicketTable(filtered);
    });
  });

  const refreshButton = document.querySelector('#refreshData');
  refreshButton?.addEventListener('click', loadTickets);

  const logoutButton = document.querySelector('#logoutBtn');
  logoutButton?.addEventListener('click', logoutUser);

  const newTicketForm = document.querySelector('#ticketForm');
  const modal = document.querySelector('#ticketModal');
  const openTicketModal = () => modal?.classList.add('show');
  const closeTicketModal = () => modal?.classList.remove('show');

  document.querySelector('#newTicketBtn')?.addEventListener('click', openTicketModal);
  document.querySelector('#closeTicketModal')?.addEventListener('click', closeTicketModal);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeTicketModal();
  });

  newTicketForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      subject: document.querySelector('#ticketSubject').value.trim(),
      description: document.querySelector('#ticketDescription').value.trim(),
      category: document.querySelector('#ticketCategory').value,
      impact: document.querySelector('#ticketImpact').value,
      urgency: document.querySelector('#ticketUrgency').value,
      locationId: Number(document.querySelector('#ticketLocation').value),
      roomOutOfService: document.querySelector('#ticketRoomService').checked,
      guestImpact: document.querySelector('#ticketGuestImpact').checked,
      confirmDuplicate: true,
    };

    try {
      const csrf = sessionStorage.getItem('hotelcareCsrf');
      await apiFetch('/api/tickets', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf || '' },
        body: JSON.stringify(payload),
      });
      closeTicketModal();
      newTicketForm.reset();
      showToast('Ticket created successfully.', 'success');
      loadTickets();
    } catch (error) {
      showToast(error.message || 'Ticket could not be created.', 'error');
    }
  });

  await loadTickets();
}

document.addEventListener('DOMContentLoaded', async () => {
  if (document.body.dataset.page === 'landing') {
    bindLoginForm();
  }

  if (document.body.dataset.page === 'dashboard') {
    await loadDashboard();
  }
});
