(function(){
  function currentPath(){ try { return location.pathname.replace('/public/','/'); } catch { return '/'; } }
  function item(href, label, icon){
    const a = document.createElement('a'); a.href = href; a.className = 'nav-item';
    a.innerHTML = `<span class="icon">${icon||'•'}</span><span>${label}</span>`;
    if (currentPath() === href) a.classList.add('active');
    return a;
  }
  function build(){
    const burger = document.createElement('button'); burger.className='nav-burger'; burger.setAttribute('aria-label','Menu'); burger.innerHTML = '<span></span>';
    const overlay = document.createElement('div'); overlay.className='nav-overlay';
    const drawer = document.createElement('nav'); drawer.className='nav-drawer'; drawer.setAttribute('role','navigation');
    const brand = document.createElement('div'); brand.className='nav-brand'; brand.innerHTML = 'Whats Tool<br/><small>Dashboard</small>';
    const list = document.createElement('div'); list.className='nav-list';
    list.appendChild(item('/', 'Dashboard', '🏠'));
    list.appendChild(item('/public/contacts.html', 'Contacts', '📱'));
    list.appendChild(item('/public/moderator.html', 'Moderator', '🧑‍💼'));
    list.appendChild(item('/public/auto-reply.html', 'Auto Reply', '🤖'));
    list.appendChild(item('/public/agent.html', 'AI Agent', '🧠'));
    list.appendChild(item('/public/extractor.html', 'Extractor', '🔎'));
    list.appendChild(item('/public/groups-extractor.html', 'Groups Extractor', '👥'));
    list.appendChild(item('/public/insights.html', 'Insights', '📊'));
    list.appendChild(item('/public/backup.html', 'Backup/Restore', '💾'));
    list.appendChild(item('/public/flows.html', 'Flow Builder', '🔄'));
    list.appendChild(item('/public/flow-analytics.html', 'Flow Analytics', '📈'));
    list.appendChild(item('/public/kb-quality.html', 'KB Quality', '📊'));
    list.appendChild(item('/public/cases.html', 'Case Studies', '🏆'));
		list.appendChild(item('/public/google-credentials.html', 'Google Credentials', '🔑'));
		list.appendChild(item('/public/confirmation-orders.html', 'Confirmation Orders', '✅'));
    list.appendChild(item('/admin', 'Admin Panel', '🔐'));
    const footer = document.createElement('div'); footer.className='nav-footer';
    footer.innerHTML = '<div class="row"><span>v2</span><div><button id="navCompact" class="icon-btn" title="Compact">🗂️</button> <button id="navTheme" class="icon-btn" title="Theme">🌓</button></div></div>';
    drawer.appendChild(brand); drawer.appendChild(list); drawer.appendChild(footer);
    document.body.appendChild(burger); document.body.appendChild(overlay); document.body.appendChild(drawer);

    function open(){ drawer.classList.add('open'); overlay.classList.add('open'); burger.classList.add('open'); document.body.classList.add('nav-open'); document.body.classList.add('drawer-open'); localStorage.setItem('navOpen','1'); }
    function close(){ drawer.classList.remove('open'); overlay.classList.remove('open'); burger.classList.remove('open'); document.body.classList.remove('nav-open'); document.body.classList.remove('drawer-open'); localStorage.setItem('navOpen','0'); }
    burger.addEventListener('click', ()=> (drawer.classList.contains('open') ? close() : open()));
    overlay.addEventListener('click', close);
    // theme toggle relay
    const navThemeBtn = footer.querySelector('#navTheme');
    function updateNavThemeIcon() {
      const dark = document.body.getAttribute('data-theme') === 'dark';
      navThemeBtn.innerHTML = dark ? '☀️' : '🌙';
    }
    
    navThemeBtn.addEventListener('click', ()=>{
      const dark = document.body.getAttribute('data-theme') === 'dark';
      if (dark) { 
        document.body.removeAttribute('data-theme'); 
        localStorage.setItem('theme','light'); 
      } else { 
        document.body.setAttribute('data-theme','dark'); 
        localStorage.setItem('theme','dark'); 
      }
      updateNavThemeIcon();
    });
    
    // Initialize theme icon
    updateNavThemeIcon();
    footer.querySelector('#navCompact').addEventListener('click', ()=>{
      const compact = document.body.classList.toggle('drawer-compact');
      localStorage.setItem('navCompact', compact ? '1' : '0');
    });

    // persistent on desktop
    function applyPersistent(){
      // default closed on first load
      const saved = localStorage.getItem('navOpen');
      if (saved === '1') { open(); } else { close(); }
      const compactSaved = localStorage.getItem('navCompact') === '1';
      if (compactSaved) document.body.classList.add('drawer-compact'); else document.body.classList.remove('drawer-compact');
    }
    window.addEventListener('resize', applyPersistent); applyPersistent();

    // keyboard: ESC to close, left/right to toggle
    window.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape') close();
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.altKey) {
        if (drawer.classList.contains('open')) close(); else open();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();


