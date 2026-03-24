// Kanban Board JavaScript
document.addEventListener('DOMContentLoaded', () => {
    // State
    let projects = [];
    let currentFilters = { agent: '', scheduleStatus: '' };
    let dragCard = null;
    let dragSourceContainer = null;

    // DOM Elements
    const kanbanBoard = document.querySelector('.kanban-board');
    const newProjectBtn = document.getElementById('new-project-btn');
    const filterAgent = document.getElementById('filter-agent');
    const filterSchedule = document.getElementById('filter-schedule');
    const clearFiltersBtn = document.getElementById('clear-filters');
    const projectModal = document.getElementById('project-modal');
    const newProjectModal = document.getElementById('new-project-modal');
    const modalCloseButtons = document.querySelectorAll('.modal-close');
    const saveProjectBtn = document.getElementById('save-project-btn');
    const cancelProjectBtn = document.getElementById('cancel-project-btn');
    const editProjectBtn = document.getElementById('edit-project-btn');
    const deleteProjectBtn = document.getElementById('delete-project-btn');
    const addNoteBtn = document.getElementById('add-note-btn');
    const newNoteTextarea = document.getElementById('new-note');
    const newProjectForm = document.getElementById('new-project-form');

    // Status mapping for display
    const statusDisplay = {
        backlog: 'Backlog',
        plan: 'Plan',
        to_do: 'To Do',
        in_progress: 'In Progress',
        review: 'Review',
        done: 'Done',
        cancelled: 'Cancelled'
    };

    // Schedule status mapping
    const scheduleDisplay = {
        on_schedule: 'On Schedule',
        at_risk: 'At Risk',
        behind: 'Behind'
    };

    // Initialize
    loadProjects();
    setupEventListeners();
    populateAgentFilter();

    // ==================== API Functions ====================
    async function loadProjects() {
        try {
            const response = await fetch('/api/projects');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            projects = await response.json();
            renderBoard();
        } catch (error) {
            console.error('Failed to load projects:', error);
            alert('Failed to load projects. Check console for details.');
        }
    }

    async function updateProject(projectId, updates) {
        try {
            const response = await fetch(`/api/projects/${projectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const updated = await response.json();
            // Update local projects array
            const index = projects.findIndex(p => p.id === projectId);
            if (index !== -1) {
                projects[index] = updated;
            }
            renderBoard();
            return updated;
        } catch (error) {
            console.error('Failed to update project:', error);
            alert('Failed to update project. Check console for details.');
        }
    }

    async function createProject(projectData) {
        try {
            const response = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(projectData)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const newProject = await response.json();
            projects.push(newProject);
            renderBoard();
            closeModal(newProjectModal);
            return newProject;
        } catch (error) {
            console.error('Failed to create project:', error);
            alert('Failed to create project. Check console for details.');
        }
    }

    async function deleteProject(projectId) {
        if (!confirm('Are you sure you want to delete this project?')) return;
        try {
            const response = await fetch(`/api/projects/${projectId}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            projects = projects.filter(p => p.id !== projectId);
            renderBoard();
            closeModal(projectModal);
        } catch (error) {
            console.error('Failed to delete project:', error);
            alert('Failed to delete project. Check console for details.');
        }
    }

    // ==================== Rendering ====================
    function renderBoard() {
        // Clear all card containers
        document.querySelectorAll('.cards-container').forEach(container => {
            container.innerHTML = '';
        });

        // Filter projects
        let filtered = projects;
        if (currentFilters.agent) {
            filtered = filtered.filter(p => p.agent === currentFilters.agent);
        }
        if (currentFilters.scheduleStatus) {
            filtered = filtered.filter(p => p.scheduleStatus === currentFilters.scheduleStatus);
        }

        // Group by status
        const grouped = {};
        filtered.forEach(project => {
            const status = project.status;
            if (!grouped[status]) grouped[status] = [];
            grouped[status].push(project);
        });

        // Render each swimlane
        Object.keys(grouped).forEach(status => {
            const container = document.querySelector(`.cards-container[data-status="${status}"]`);
            if (!container) return;
            grouped[status].forEach(project => {
                container.appendChild(createProjectCard(project));
            });
            // Update card count
            const header = container.closest('.swimlane').querySelector('.card-count');
            header.textContent = grouped[status].length;
        });
    }

    function createProjectCard(project) {
        const card = document.createElement('div');
        card.className = 'project-card';
        card.dataset.projectId = project.id;
        card.draggable = true;

        const scheduleClass = `schedule-${project.scheduleStatus}`;
        const scheduleText = scheduleDisplay[project.scheduleStatus] || project.scheduleStatus;

        card.innerHTML = `
            <h4>${project.title}</h4>
            <p>${project.description || ''}</p>
            <div class="project-card-meta">
                <span class="agent-badge">${project.agent}</span>
                <span>
                    <span class="schedule-indicator ${scheduleClass}"></span>
                    ${scheduleText}
                </span>
            </div>
            <div class="project-card-meta" style="margin-top: 0.5rem; font-size: 0.7rem;">
                <span>Due: ${formatDate(project.dueDate)}</span>
                <span>ETA: ${formatDate(project.eta)}</span>
            </div>
        `;

        // Click to open detail modal
        card.addEventListener('click', (e) => {
            if (!e.target.closest('.project-card-meta')) {
                openProjectDetail(project);
            }
        });

        // Drag events
        card.addEventListener('dragstart', handleDragStart);
        card.addEventListener('dragend', handleDragEnd);

        return card;
    }

    function openProjectDetail(project) {
        document.getElementById('modal-title').textContent = project.title;
        document.getElementById('detail-title').textContent = project.title;
        document.getElementById('detail-description').textContent = project.description || '';
        document.getElementById('detail-agent').textContent = project.agent;
        document.getElementById('detail-status').textContent = statusDisplay[project.status] || project.status;
        document.getElementById('detail-due').textContent = formatDate(project.dueDate);
        document.getElementById('detail-eta').textContent = formatDate(project.eta);
        document.getElementById('detail-schedule').textContent = scheduleDisplay[project.scheduleStatus] || project.scheduleStatus;

        // Progress notes
        const notesList = document.getElementById('detail-notes');
        notesList.innerHTML = '';
        project.progressNotes?.forEach(note => {
            const li = document.createElement('li');
            li.innerHTML = `<strong>${formatDate(note.date)} (${note.author}):</strong> ${note.note}`;
            notesList.appendChild(li);
        });

        // Impediments
        const impedimentsList = document.getElementById('detail-impediments');
        impedimentsList.innerHTML = '';
        project.impediments?.forEach(imp => {
            const li = document.createElement('li');
            li.innerHTML = `<strong>${formatDate(imp.date)}:</strong> ${imp.description} ${imp.resolved ? '(Resolved)' : '(Active)'}`;
            impedimentsList.appendChild(li);
        });

        // Blockers
        const blockersList = document.getElementById('detail-blockers');
        blockersList.innerHTML = '';
        project.blockers?.forEach(blocker => {
            const li = document.createElement('li');
            li.innerHTML = `<strong>${formatDate(blocker.date)}:</strong> ${blocker.description}`;
            blockersList.appendChild(li);
        });

        // Set up buttons with current project ID
        editProjectBtn.onclick = () => openEditProject(project);
        deleteProjectBtn.onclick = () => deleteProject(project.id);
        addNoteBtn.onclick = () => addProgressNote(project.id);

        openModal(projectModal);
    }

    function openEditProject(project) {
        // For simplicity, we'll just update status via drag-drop.
        // A full edit form could be added later.
        alert('Edit feature not yet implemented. Use drag‑and‑drop to change status.');
    }

    function addProgressNote(projectId) {
        const note = newNoteTextarea.value.trim();
        if (!note) return;
        const project = projects.find(p => p.id === projectId);
        if (!project) return;
        const newNote = {
            date: new Date().toISOString(),
            note,
            author: 'user' // In a real app, get current user
        };
        project.progressNotes = project.progressNotes || [];
        project.progressNotes.push(newNote);
        updateProject(projectId, { progressNotes: project.progressNotes });
        newNoteTextarea.value = '';
        openProjectDetail(project); // Refresh detail view
    }

    // ==================== Drag & Drop ====================
    function handleDragStart(e) {
        dragCard = this;
        dragSourceContainer = this.parentElement;
        setTimeout(() => this.classList.add('dragging'), 0);
        e.dataTransfer.setData('text/plain', this.dataset.projectId);
    }

    function handleDragEnd() {
        this.classList.remove('dragging');
        dragCard = null;
        dragSourceContainer = null;
    }

    // Setup droppable containers
    document.querySelectorAll('.cards-container').forEach(container => {
        container.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });

        container.addEventListener('drop', async e => {
            e.preventDefault();
            if (!dragCard) return;
            const projectId = dragCard.dataset.projectId;
            const newStatus = container.dataset.status;
            await updateProject(projectId, { status: newStatus });
        });
    });

    // ==================== Filters ====================
    function populateAgentFilter() {
        const agents = [...new Set(projects.map(p => p.agent))];
        agents.forEach(agent => {
            const option = document.createElement('option');
            option.value = agent;
            option.textContent = agent;
            filterAgent.appendChild(option);
        });
    }

    filterAgent.addEventListener('change', () => {
        currentFilters.agent = filterAgent.value;
        renderBoard();
    });

    filterSchedule.addEventListener('change', () => {
        currentFilters.scheduleStatus = filterSchedule.value;
        renderBoard();
    });

    clearFiltersBtn.addEventListener('click', () => {
        filterAgent.value = '';
        filterSchedule.value = '';
        currentFilters = { agent: '', scheduleStatus: '' };
        renderBoard();
    });

    // ==================== Modal Management ====================
    function openModal(modal) {
        modal.classList.add('active');
    }

    function closeModal(modal) {
        modal.classList.remove('active');
    }

    modalCloseButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            closeModal(btn.closest('.modal'));
        });
    });

    // Close modal when clicking outside content
    window.addEventListener('click', (e) => {
        if (e.target === projectModal) closeModal(projectModal);
        if (e.target === newProjectModal) closeModal(newProjectModal);
    });

    // ==================== New Project ====================
    newProjectBtn.addEventListener('click', () => openModal(newProjectModal));

    cancelProjectBtn.addEventListener('click', () => closeModal(newProjectModal));

    saveProjectBtn.addEventListener('click', async () => {
        const title = document.getElementById('project-title').value.trim();
        if (!title) {
            alert('Title is required');
            return;
        }
        const projectData = {
            title,
            description: document.getElementById('project-description').value,
            agent: document.getElementById('project-agent').value,
            status: document.getElementById('project-status').value,
            dueDate: document.getElementById('project-due').value ? new Date(document.getElementById('project-due').value).toISOString() : null,
            eta: document.getElementById('project-eta').value ? new Date(document.getElementById('project-eta').value).toISOString() : null,
            scheduleStatus: 'on_schedule'
        };
        await createProject(projectData);
        newProjectForm.reset();
    });

    // ==================== Utilities ====================
    function formatDate(isoString) {
        if (!isoString) return 'N/A';
        const date = new Date(isoString);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function setupEventListeners() {
        // Already set up above
    }
});