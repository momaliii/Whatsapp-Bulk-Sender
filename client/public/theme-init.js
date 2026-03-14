// Theme initialization script for all pages
(function() {
  // Initialize theme on page load
  function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
    } else {
      document.body.removeAttribute('data-theme');
    }
  }
  
  // Initialize theme immediately
  initTheme();
  
  // Also initialize when DOM is ready (fallback)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTheme);
  }
})();
