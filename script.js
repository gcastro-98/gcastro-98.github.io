// ====== Custom WebGL Mesh Gradient ======
const oldCanvas = document.getElementById('bg-canvas');
const scene = new THREE.Scene();

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// Replace the old canvas safely
if(oldCanvas && oldCanvas.parentNode) {
    oldCanvas.parentNode.replaceChild(renderer.domElement, oldCanvas);
    renderer.domElement.id = 'bg-canvas';
    // Must add the class for pos:fixed
    renderer.domElement.className = 'canvas-container';
}

const uniforms = {
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(window.innerWidth/2, window.innerHeight/2) },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
};

const material = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: document.getElementById('vertexShader').textContent,
    fragmentShader: document.getElementById('fragmentShader').textContent
});

const geometry = new THREE.PlaneGeometry(2, 2);
const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
});

const currentMouse = new THREE.Vector2(window.innerWidth/2, window.innerHeight/2);
const targetMouse = new THREE.Vector2(window.innerWidth/2, window.innerHeight/2);

window.addEventListener('mousemove', (e) => {
    targetMouse.x = e.clientX;
    targetMouse.y = window.innerHeight - e.clientY; 
});
window.addEventListener('touchmove', (e) => {
    targetMouse.x = e.touches[0].clientX;
    targetMouse.y = window.innerHeight - e.touches[0].clientY;
});

const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    
    currentMouse.x += (targetMouse.x - currentMouse.x) * 0.08;
    currentMouse.y += (targetMouse.y - currentMouse.y) * 0.08;
    
    uniforms.uMouse.value.copy(currentMouse);
    uniforms.uTime.value = clock.getElapsedTime();
    
    renderer.render(scene, camera);
}
animate();


// ====== Timeline Scroll Observer ======
const snapContainer = document.getElementById('snap-container');
const sections = document.querySelectorAll('.section');
const navLinks = document.querySelectorAll('.timeline a');
const indicator = document.getElementById('indicator');

const observerOptions = {
    root: snapContainer,
    rootMargin: '0px',
    threshold: 0.5 
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');

            let activeId = entry.target.id;
            navLinks.forEach(link => {
                link.classList.remove('active');
                if (link.getAttribute('data-section') === activeId) {
                    link.classList.add('active');
                    if(indicator) {
                        const linkRect = link.getBoundingClientRect();
                        const containerRect = document.querySelector('.timeline').getBoundingClientRect();
                        const topOffset = linkRect.top - containerRect.top + (linkRect.height / 2) - 5;
                        indicator.style.top = `${topOffset}px`;
                    }
                }
            });
        }
    });
}, observerOptions);

sections.forEach(section => observer.observe(section));

setTimeout(() => {
    const activeLink = document.querySelector('.timeline a.active');
    if(activeLink && indicator) {
        const linkRect = activeLink.getBoundingClientRect();
        const containerRect = document.querySelector('.timeline').getBoundingClientRect();
        const topOffset = linkRect.top - containerRect.top + (linkRect.height / 2) - 5;
        indicator.style.top = `${topOffset}px`;
    }
}, 300);

navLinks.forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const targetId = this.getAttribute('href').substring(1);
        const targetSection = document.getElementById(targetId);
        if(targetSection) {
            snapContainer.scrollTo({
                top: targetSection.offsetTop,
                behavior: 'smooth'
            });
        }
    });
});
