// === OptiAss — AI Reminder Assistant ===
// Persistent reminders with notifications & alarm sounds every interval until marked complete.

(function () {
    'use strict';

    // ── State ──
    let reminders = JSON.parse(localStorage.getItem('optiass_reminders') || '[]');
    let completedReminders = JSON.parse(localStorage.getItem('optiass_completed') || '[]');
    let currentFilter = 'all';
    let alarmAudio = null;
    let checkInterval = null;
    let activeAlarmId = null;

    // ── DOM Elements ──
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    const form = $('#reminder-form');
    const titleInput = $('#reminder-title');
    const prioritySelect = $('#reminder-priority');
    const intervalSelect = $('#reminder-interval');
    const soundSelect = $('#reminder-sound');
    const notesInput = $('#reminder-notes');
    const remindersList = $('#reminders-list');
    const emptyState = $('#empty-state');
    const completedList = $('#completed-list');
    const completedCount = $('#completed-count');
    const notifStatusBadge = $('#notification-status');
    const enableNotifBtn = $('#enable-notifications-btn');
    const alarmOverlay = $('#alarm-overlay');
    const alarmMessage = $('#alarm-message');
    const alarmCompleteBtn = $('#alarm-complete-btn');
    const alarmSnoozeBtn = $('#alarm-snooze-btn');
    const alarmDismissBtn = $('#alarm-dismiss-btn');
    const aiChatToggle = $('#ai-chat-toggle');
    const aiChatPanel = $('#ai-chat-panel');
    const aiChatClose = $('#ai-chat-close');
    const chatForm = $('#chat-form');
    const chatInput = $('#chat-input');
    const chatMessages = $('#chat-messages');

    // ── Audio Generation (Web Audio API) ──
    function createAlarmSound(type) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const gainNode = ctx.createGain();
        gainNode.connect(ctx.destination);

        function playTone(freq, start, duration, vol) {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.connect(g);
            g.connect(ctx.destination);
            osc.frequency.value = freq;
            osc.type = 'sine';
            g.gain.setValueAtTime(vol, ctx.currentTime + start);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
            osc.start(ctx.currentTime + start);
            osc.stop(ctx.currentTime + start + duration);
        }

        if (type === 'gentle') {
            for (let i = 0; i < 6; i++) {
                playTone(800, i * 0.5, 0.3, 0.15);
                playTone(1000, i * 0.5 + 0.15, 0.3, 0.1);
            }
        } else if (type === 'urgent') {
            for (let i = 0; i < 8; i++) {
                playTone(880, i * 0.35, 0.2, 0.25);
                playTone(1100, i * 0.35 + 0.1, 0.2, 0.2);
            }
        } else if (type === 'alarm') {
            for (let i = 0; i < 10; i++) {
                playTone(700 + (i % 2) * 400, i * 0.25, 0.2, 0.3);
            }
        } else if (type === 'persistent') {
            for (let i = 0; i < 15; i++) {
                playTone(900, i * 0.2, 0.15, 0.35);
                playTone(1200, i * 0.2 + 0.05, 0.15, 0.3);
            }
        }
        return ctx;
    }

    let alarmCtx = null;
    let alarmRepeatTimer = null;

    function startAlarmSound(type) {
        stopAlarmSound();
        alarmCtx = createAlarmSound(type);
        // Repeat the alarm sound every 4 seconds
        alarmRepeatTimer = setInterval(() => {
            try { alarmCtx = createAlarmSound(type); } catch (e) { /* ignore */ }
        }, 4000);
    }

    function stopAlarmSound() {
        if (alarmRepeatTimer) { clearInterval(alarmRepeatTimer); alarmRepeatTimer = null; }
        if (alarmCtx) { try { alarmCtx.close(); } catch (e) { /* ignore */ } alarmCtx = null; }
    }

    // ── Notifications ──
    function updateNotifStatus() {
        if ('Notification' in window && Notification.permission === 'granted') {
            notifStatusBadge.classList.add('active');
            notifStatusBadge.querySelector('.status-text').textContent = 'Notifications On';
        } else {
            notifStatusBadge.classList.remove('active');
            notifStatusBadge.querySelector('.status-text').textContent = 'Notifications Off';
        }
    }

    async function requestNotificationPermission() {
        if (!('Notification' in window)) {
            alert('Your browser does not support notifications. Please use Chrome or Firefox.');
            return;
        }
        const perm = await Notification.requestPermission();
        updateNotifStatus();
        if (perm === 'granted') {
            new Notification('OptiAss Activated! ✅', {
                body: 'You will now receive persistent reminders. Stay on track!',
                icon: '🔔',
                tag: 'optiass-enabled'
            });
        }
    }

    function sendNotification(reminder) {
        if ('Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(`⏰ OptiAss Reminder: ${reminder.title}`, {
                body: reminder.notes || `Priority: ${reminder.priority.toUpperCase()} — Complete this task!`,
                tag: `optiass-${reminder.id}`,
                requireInteraction: true,
                renotify: true
            });
            n.onclick = () => {
                window.focus();
                showAlarmOverlay(reminder);
                n.close();
            };
        }
    }

    // ── Persistence ──
    function save() {
        localStorage.setItem('optiass_reminders', JSON.stringify(reminders));
        localStorage.setItem('optiass_completed', JSON.stringify(completedReminders));
    }

    // ── Time Helpers ──
    function timeAgo(ts) {
        const diff = Date.now() - ts;
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return `${Math.floor(hrs / 24)}d ago`;
    }

    function nextCheckIn(reminder) {
        const intervalMs = reminder.interval * 60000;
        const lastNotif = reminder.lastNotified || reminder.createdAt;
        const next = lastNotif + intervalMs;
        const diff = next - Date.now();
        if (diff <= 0) return 'NOW';
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m`;
        return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    }

    // ── Render ──
    function renderReminders() {
        // Filter
        let filtered = reminders;
        if (currentFilter === 'critical') filtered = reminders.filter(r => r.priority === 'critical');
        else if (currentFilter === 'high') filtered = reminders.filter(r => r.priority === 'high');
        else if (currentFilter === 'overdue') filtered = reminders.filter(r => isOverdue(r));

        // Clear list (keep empty state)
        remindersList.innerHTML = '';

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.innerHTML = `
                <div class="empty-icon">📋</div>
                <h3>${currentFilter === 'all' ? 'No active reminders' : 'No ' + currentFilter + ' reminders'}</h3>
                <p>Add your first reminder above and OptiAss will keep you on track!</p>
            `;
            remindersList.appendChild(empty);
        } else {
            filtered.forEach(r => remindersList.appendChild(createReminderCard(r)));
        }

        // Completed
        completedList.innerHTML = '';
        completedReminders.slice().reverse().forEach(r => completedList.appendChild(createCompletedCard(r)));
        completedCount.textContent = completedReminders.length;

        updateStats();
    }

    function isOverdue(r) {
        const intervalMs = r.interval * 60000;
        const lastNotif = r.lastNotified || r.createdAt;
        return Date.now() - lastNotif >= intervalMs;
    }

    function createReminderCard(r) {
        const card = document.createElement('div');
        card.className = `reminder-card priority-${r.priority}`;
        if (isOverdue(r)) card.classList.add('overdue');

        const overdueBadge = isOverdue(r) ? '<span class="reminder-tag overdue-tag">OVERDUE</span>' : '';
        const priorityColors = { low: '🟢', medium: '🟡', high: '🔴', critical: '🚨' };

        card.innerHTML = `
            <button class="reminder-checkbox" data-id="${r.id}" title="Mark Complete"></button>
            <div class="reminder-info">
                <div class="reminder-title">${escapeHtml(r.title)}</div>
                <div class="reminder-meta">
                    <span class="reminder-tag">${priorityColors[r.priority]} ${r.priority}</span>
                    <span class="reminder-tag">Every ${r.interval}m</span>
                    ${overdueBadge}
                    <span class="reminder-time">Next: ${nextCheckIn(r)} · Created ${timeAgo(r.createdAt)}</span>
                </div>
                ${r.notes ? `<div class="reminder-notes">${escapeHtml(r.notes)}</div>` : ''}
            </div>
            <div class="reminder-actions">
                <button class="btn-icon-action" data-delete="${r.id}" title="Delete">🗑</button>
            </div>
        `;

        // Complete
        card.querySelector('.reminder-checkbox').addEventListener('click', () => completeReminder(r.id));
        // Delete
        card.querySelector('[data-delete]').addEventListener('click', () => deleteReminder(r.id));

        return card;
    }

    function createCompletedCard(r) {
        const card = document.createElement('div');
        card.className = 'reminder-card completed-card';
        card.innerHTML = `
            <div class="reminder-checkbox checked"></div>
            <div class="reminder-info">
                <div class="reminder-title">${escapeHtml(r.title)}</div>
                <div class="reminder-meta">
                    <span class="reminder-time">Completed ${timeAgo(r.completedAt)}</span>
                </div>
            </div>
        `;
        return card;
    }

    function updateStats() {
        $('#stat-active').textContent = reminders.length;
        $('#stat-completed').textContent = completedReminders.length;
        $('#stat-overdue').textContent = reminders.filter(isOverdue).length;

        // Next check
        if (reminders.length > 0) {
            const times = reminders.map(r => {
                const intervalMs = r.interval * 60000;
                const lastNotif = r.lastNotified || r.createdAt;
                return lastNotif + intervalMs;
            });
            const nearest = Math.min(...times);
            const diff = nearest - Date.now();
            if (diff <= 0) {
                $('#stat-next').textContent = 'NOW';
            } else {
                const mins = Math.floor(diff / 60000);
                $('#stat-next').textContent = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
            }
        } else {
            $('#stat-next').textContent = '--';
        }
    }

    // ── CRUD ──
    function addReminder(title, priority, interval, sound, notes) {
        const r = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            title, priority,
            interval: parseInt(interval),
            sound, notes,
            createdAt: Date.now(),
            lastNotified: Date.now()
        };
        reminders.push(r);
        save();
        renderReminders();
        return r;
    }

    function completeReminder(id) {
        const idx = reminders.findIndex(r => r.id === id);
        if (idx === -1) return;
        const r = reminders.splice(idx, 1)[0];
        r.completedAt = Date.now();
        completedReminders.push(r);
        save();
        renderReminders();
        if (activeAlarmId === id) hideAlarmOverlay();
    }

    function deleteReminder(id) {
        reminders = reminders.filter(r => r.id !== id);
        save();
        renderReminders();
        if (activeAlarmId === id) hideAlarmOverlay();
    }

    // ── Alarm Overlay ──
    function showAlarmOverlay(reminder) {
        activeAlarmId = reminder.id;
        alarmMessage.textContent = reminder.title;
        alarmOverlay.classList.remove('hidden');
        startAlarmSound(reminder.sound);
        // Vibrate if supported
        if (navigator.vibrate) {
            navigator.vibrate([500, 200, 500, 200, 500, 200, 500]);
        }
    }

    function hideAlarmOverlay() {
        alarmOverlay.classList.add('hidden');
        stopAlarmSound();
        activeAlarmId = null;
    }

    // ── Periodic Check (runs every 30s) ──
    function checkReminders() {
        const now = Date.now();
        reminders.forEach(r => {
            const intervalMs = r.interval * 60000;
            const lastNotif = r.lastNotified || r.createdAt;
            if (now - lastNotif >= intervalMs) {
                // Time to remind!
                sendNotification(r);
                // Show alarm overlay for the first overdue one
                if (!activeAlarmId) {
                    showAlarmOverlay(r);
                }
                r.lastNotified = now;
            }
        });
        save();
        renderReminders();
    }

    // ── AI Chat ──
    function handleAIChat(message) {
        const lower = message.toLowerCase().trim();

        // Simple AI-like responses
        if (lower.includes('remind me') || lower.includes('add reminder') || lower.includes('remember')) {
            const task = message.replace(/remind me to|add reminder|remember to/gi, '').trim();
            if (task.length > 2) {
                const r = addReminder(task, 'medium', 120, 'urgent', '');
                return `✅ Done! I've added "${task}" as a reminder. I'll check in every 2 hours until you complete it.`;
            }
            return "What would you like me to remind you about? Try: 'Remind me to take medicine'";
        }

        if (lower.includes('overdue') || lower.includes('pending') || lower.includes('late')) {
            const overdue = reminders.filter(isOverdue);
            if (overdue.length === 0) return "🎉 Great news! You have no overdue reminders.";
            const list = overdue.map(r => `• ${r.title} (${r.priority})`).join('\n');
            return `⚠️ You have ${overdue.length} overdue reminder(s):\n${list}`;
        }

        if (lower.includes('next') || lower.includes('upcoming')) {
            if (reminders.length === 0) return "📋 No active reminders. Add one to get started!";
            const sorted = [...reminders].sort((a, b) => {
                const na = (a.lastNotified || a.createdAt) + a.interval * 60000;
                const nb = (b.lastNotified || b.createdAt) + b.interval * 60000;
                return na - nb;
            });
            const next = sorted[0];
            return `⏰ Your next reminder is "${next.title}" — due in ${nextCheckIn(next)}.`;
        }

        if (lower.includes('how many') || lower.includes('count') || lower.includes('status') || lower.includes('summary')) {
            return `📊 Status Report:\n• Active: ${reminders.length}\n• Completed: ${completedReminders.length}\n• Overdue: ${reminders.filter(isOverdue).length}\n\nKeep going! 💪`;
        }

        if (lower.includes('clear completed') || lower.includes('delete completed')) {
            completedReminders = [];
            save();
            renderReminders();
            return "🧹 All completed reminders have been cleared!";
        }

        if (lower.includes('help') || lower.includes('what can you do')) {
            return `I can help you with:\n• "Remind me to [task]" — Add a reminder\n• "Show overdue" — See overdue tasks\n• "Next reminder" — Your nearest deadline\n• "Status" — Overview of all reminders\n• "Clear completed" — Clean up done tasks`;
        }

        // Default response
        const responses = [
            "I'm here to help with your reminders! Try 'remind me to...' or 'show overdue'.",
            "Need help? Say 'help' to see what I can do! 🤖",
            "I'm your reminder assistant. Try adding a task: 'Remind me to call the client'.",
        ];
        return responses[Math.floor(Math.random() * responses.length)];
    }

    function addChatMessage(text, isUser) {
        const div = document.createElement('div');
        div.className = `chat-message ${isUser ? 'user-message' : 'ai-message'}`;
        div.innerHTML = `<div class="message-bubble"><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p></div>`;
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // ── Utilities ──
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ── Event Listeners ──
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = titleInput.value.trim();
        if (!title) return;
        addReminder(title, prioritySelect.value, intervalSelect.value, soundSelect.value, notesInput.value.trim());
        titleInput.value = '';
        notesInput.value = '';
        titleInput.focus();
    });

    enableNotifBtn.addEventListener('click', requestNotificationPermission);

    // Filter tabs
    $$('.filter-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            $$('.filter-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentFilter = tab.dataset.filter;
            renderReminders();
        });
    });

    // Alarm overlay
    alarmCompleteBtn.addEventListener('click', () => {
        if (activeAlarmId) completeReminder(activeAlarmId);
        hideAlarmOverlay();
    });
    alarmSnoozeBtn.addEventListener('click', () => {
        if (activeAlarmId) {
            const r = reminders.find(rem => rem.id === activeAlarmId);
            if (r) {
                r.lastNotified = Date.now() - (r.interval * 60000) + 1800000; // snooze 30 min
                save();
            }
        }
        hideAlarmOverlay();
    });
    alarmDismissBtn.addEventListener('click', hideAlarmOverlay);

    // AI Chat
    aiChatToggle.addEventListener('click', () => {
        aiChatPanel.classList.toggle('hidden');
        if (!aiChatPanel.classList.contains('hidden')) chatInput.focus();
    });
    aiChatClose.addEventListener('click', () => aiChatPanel.classList.add('hidden'));

    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const msg = chatInput.value.trim();
        if (!msg) return;
        addChatMessage(msg, true);
        chatInput.value = '';
        // Simulate AI thinking
        setTimeout(() => {
            const response = handleAIChat(msg);
            addChatMessage(response, false);
        }, 400);
    });

    // ── Init ──
    function init() {
        updateNotifStatus();
        renderReminders();
        // Check reminders every 30 seconds
        checkInterval = setInterval(checkReminders, 30000);
        // Also check on visibility change
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) checkReminders();
        });
    }

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').then(reg => {
                console.log('SW Registered!', reg);
            }).catch(err => {
                console.log('SW Registration Failed!', err);
            });
        });
    }

    init();
})();
