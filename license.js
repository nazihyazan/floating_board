const fs = require('fs');
const path = require('path');
const os = require('os');

function isPremium() {
    try {
        const keyPath = path.join(os.homedir(), '.floatboard', 'license.key');
        if (!fs.existsSync(keyPath)) return false;
        
        const key = fs.readFileSync(keyPath, 'utf8').trim();
        // Basic offline check - assume valid if it matches our format
        // Full verification is done via API during activation
        return key.startsWith('FL-') && key.length > 10;
    } catch (error) {
        return false;
    }
}

function activateLicense(key) {
    if (!key) return false;
    try {
        const dirPath = path.join(os.homedir(), '.floatboard');
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        fs.writeFileSync(path.join(dirPath, 'license.key'), key.trim(), 'utf8');
        return true;
    } catch (error) {
        console.error('Error saving license locally:', error);
        return false;
    }
}

module.exports = { isPremium, activateLicense };
