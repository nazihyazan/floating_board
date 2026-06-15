const fs = require('fs');
const path = require('path');
const os = require('os');

function isPremium() {
    try {
        const keyPath = path.join(os.homedir(), '.floatboard', 'license.key');
        if (!fs.existsSync(keyPath)) return false;
        
        const content = fs.readFileSync(keyPath, 'utf8').trim();
        
        let key = content;
        // Try parsing as JSON first (new format)
        try {
            const data = JSON.parse(content);
            if (data && data.key) {
                key = data.key;
            }
        } catch (e) {
            // Fallback to raw string (old format) and auto-migrate
            if (typeof key === 'string' && key.length > 10) {
                // Auto-migrate to JSON format in the background
                try {
                    const data = {
                        email: '',
                        key: key,
                        activatedAt: new Date().toISOString(),
                        migrated: true
                    };
                    fs.writeFileSync(keyPath, JSON.stringify(data, null, 2), 'utf8');
                } catch (writeErr) {
                    // Ignore write errors during migration
                }
            }
        }
        
        // Basic offline check - ensure key is present and looks like a valid string
        return typeof key === 'string' && key.length > 10;
    } catch (error) {
        return false;
    }
}

function activateLicense(email, key) {
    if (!key) return false;
    try {
        const dirPath = path.join(os.homedir(), '.floatboard');
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        
        const data = {
            email: email ? email.trim() : '',
            key: key.trim(),
            activatedAt: new Date().toISOString()
        };
        
        fs.writeFileSync(path.join(dirPath, 'license.key'), JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('Error saving license locally:', error);
        return false;
    }
}

module.exports = { isPremium, activateLicense };
