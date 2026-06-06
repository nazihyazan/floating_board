const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const landingDir = '/home/nazih/Downloads/landing page';
const indexFile = path.join(landingDir, 'index.html');
const pricingFile = path.join(landingDir, 'pricing.html');

// 1. Minify CSS helper
function minifyCSS(html) {
    return html.replace(/<style>([\s\S]*?)<\/style>/g, (match, css) => {
        const minified = css
            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove comments
            .replace(/\s+/g, ' ')             // Collapse whitespace
            .replace(/\s*([\{\}\:\;\,])\s*/g, '$1') // Remove spaces around syntax
            .replace(/;\}/g, '}');            // Remove trailing semicolons
        return `<style>${minified}</style>`;
    });
}

// 2. Add canonical tags, defer scripts, preload fonts
function updateHead(html, canonicalUrl) {
    // Add canonical if missing
    if (!html.includes('rel="canonical"')) {
        html = html.replace('</title>', `</title>\n    <link rel="canonical" href="${canonicalUrl}" />`);
    }
    
    // Add preload to Google fonts
    if (html.includes('rel="stylesheet"') && html.includes('fonts.googleapis.com')) {
        html = html.replace(
            /<link href="https:\/\/fonts.googleapis.com\/css2\?[^"]+" rel="stylesheet">/g, 
            match => `<link rel="preload" href="${match.match(/href="([^"]+)"/)[1]}" as="style">\n    ${match}`
        );
    }

    // Defer scripts
    html = html.replace(/<script(?![^>]*defer)([^>]*)>/g, '<script defer$1>');
    return html;
}

// 3. Update index.html
let indexHtml = fs.readFileSync(indexFile, 'utf8');

// Title & Meta
indexHtml = indexHtml.replace(/<title>.*<\/title>/, '<title>FloatBoard - Floating Clipboard Always on Top</title>');
if (indexHtml.includes('name="description"')) {
    indexHtml = indexHtml.replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="Free floating clipboard that stays above windows. Paste text, images & videos. Download for Windows, Mac & Linux.">');
} else {
    indexHtml = indexHtml.replace('<title>', '<meta name="description" content="Free floating clipboard that stays above windows. Paste text, images & videos. Download for Windows, Mac & Linux.">\n    <title>');
}

// Keyword injections
indexHtml = indexHtml.replace(/<h1[^>]*>Your clipboard, always on top<\/h1>/, '<h1 class="fade-in visible">FloatBoard - The Ultimate Floating Clipboard Manager</h1>');
indexHtml = indexHtml.replace(/FloatBoard stays above every window\. Paste texts, images, and videos effortlessly without losing your context\./, 'FloatBoard is an always on top widget that acts as your desktop productivity tool. As a powerful clipboard manager, it creates a floating workspace where you can paste images and text effortlessly without losing context.');
indexHtml = indexHtml.replace(/>Download for Free</, '>Download Free Clipboard Manager<');
indexHtml = indexHtml.replace(/>View Pricing</, '>View Premium Workspace Features<');

// Internal linking
if (!indexHtml.includes('Need more? View Premium features')) {
    indexHtml = indexHtml.replace('</section>\n\n        <section class="showcases-section', '<div style="text-align: center; margin-top: 40px;"><a href="pricing.html" style="color: var(--text-muted); font-weight: 600; text-decoration: none;">Need more? View Premium features →</a></div>\n        </section>\n\n        <section class="showcases-section');
}

// Image optimizations
const imgs = [
    { src: 'assets/images/pexels-thilina-alagiyawanna-3266092-36214461.jpg', alt: 'Background Application using floating clipboard', w: 1000, h: 600 },
    { src: 'assets/images/birmingham-museums-trust-nbneQlI2M1A-unsplash.jpg', alt: 'FloatBoard interface showing text and image split view', w: 400, h: 300 },
    { src: 'assets/images/pexels-sinan-aslan-1844393508-33619479.jpg', alt: 'Code snippet behind always on top widget', w: 1000, h: 600 },
    { src: 'assets/images/mads-schmidt-rasmussen-xfngap_DToE-unsplash.jpg', alt: 'Code editor with floating workspace', w: 400, h: 300 },
    { src: 'assets/images/pexels-jan-van-der-wolf-11680885-37537468.jpg', alt: 'Desktop productivity tool background', w: 1000, h: 600 },
    { src: 'assets/images/pexels-justyna-sieczka-2161487384-37534963.jpg', alt: 'Clipboard manager history list', w: 400, h: 300 },
    { src: 'assets/images/pexels-karola-g-4622942.jpg', alt: 'Drag and drop files background application', w: 1000, h: 600 },
    { src: 'assets/images/pexels-leon-kohle-3158283-14038353.jpg', alt: 'Paste images and text thumbnail', w: 400, h: 300 }
];

imgs.forEach(img => {
    const webpSrc = img.src.replace(/\.(jpg|png)$/, '.webp');
    // Convert to webp
    try {
        if (!fs.existsSync(path.join(landingDir, webpSrc))) {
            execSync(`ffmpeg -i "${path.join(landingDir, img.src)}" -c:v webp "${path.join(landingDir, webpSrc)}" -y -v quiet`);
        }
    } catch (e) {
        console.log('Failed to convert', img.src);
    }
    
    // Replace in HTML
    const regex = new RegExp(`<img src="${img.src}"[^>]*>`, 'g');
    indexHtml = indexHtml.replace(regex, `<img src="${webpSrc}" alt="${img.alt}" loading="lazy" width="${img.w}" height="${img.h}" class="m-img showcase-bg-img">`);
});

// Update icon to webp for img tag
try {
    execSync(`ffmpeg -i "${path.join(landingDir, 'assets/icon.png')}" -c:v webp "${path.join(landingDir, 'assets/icon.webp')}" -y -v quiet`);
} catch(e){}
indexHtml = indexHtml.replace(/<img src="assets\/icon\.png"[^>]*>/g, '<img src="assets/icon.webp" alt="FloatBoard logo - floating clipboard app" width="20" height="20">');

indexHtml = minifyCSS(indexHtml);
indexHtml = updateHead(indexHtml, 'https://floatboard.xyz/');

// Specific fix for class names messed up by global replace
indexHtml = indexHtml.replace(/class="m-img showcase-bg-img"/g, match => {
    // We will let them inherit styles or just remove this hacky class and rely on existing CSS
    return match;
});

// To be safe, just restore original classes
indexHtml = indexHtml.replace(/<img src="([^"]+)" alt="([^"]+)" loading="lazy" width="(\d+)" height="(\d+)" class="m-img showcase-bg-img">/g, (match, src, alt, w, h) => {
    let className = src.includes('pexels-') && !src.includes('leon') && !src.includes('justyna') ? 'showcase-bg-img' : 'm-img';
    if(src.includes('leon-kohle') && !indexHtml.includes('object-position: top')) className = ''; 
    return `<img src="${src}" alt="${alt}" loading="lazy" width="${w}" height="${h}" class="${className}">`;
});

fs.writeFileSync(indexFile, indexHtml);

// 4. Update pricing.html
let pricingHtml = fs.readFileSync(pricingFile, 'utf8');

pricingHtml = pricingHtml.replace(/<title>.*<\/title>/, '<title>FloatBoard Premium - Lifetime Access | $9.99</title>');
if (pricingHtml.includes('name="description"')) {
    pricingHtml = pricingHtml.replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="Unlock unlimited texts, images & windows with FloatBoard Premium. One-time payment of $9.99. Lifetime access.">');
} else {
    pricingHtml = pricingHtml.replace('<title>', '<meta name="description" content="Unlock unlimited texts, images & windows with FloatBoard Premium. One-time payment of $9.99. Lifetime access.">\n    <title>');
}

if (!pricingHtml.includes('Back to home')) {
    pricingHtml = pricingHtml.replace('</section>\n\n        <section class="faq-section">', '<div style="text-align: center; margin-top: 20px; margin-bottom: 60px;"><a href="index.html" style="color: var(--text-muted); font-weight: 600; text-decoration: none;">← Back to home</a></div>\n        </section>\n\n        <section class="faq-section">');
}

pricingHtml = pricingHtml.replace(/<img src="assets\/icon\.png"[^>]*>/g, '<img src="assets/icon.webp" alt="FloatBoard logo - floating clipboard app" width="24" height="24">');

pricingHtml = minifyCSS(pricingHtml);
pricingHtml = updateHead(pricingHtml, 'https://floatboard.xyz/pricing.html');

fs.writeFileSync(pricingFile, pricingHtml);
console.log('SEO optimization complete');
