// Accounts belong to this browser. Only the signed-in display name is shared
// with the multiplayer server; passwords and password hashes stay local.
window.Auth = (function() {
    const accountsKey = 'table-tennis.accounts.v1';
    const sessionKey = 'table-tennis.session.v1';
    const iterations = 120000;

    function storage(kind) {
        try {
            const value = window[kind];
            if (value) return value;
        } catch (_) {
            // Some browser privacy settings reject even reading this property.
        }
        throw new Error('Browser storage is unavailable. Enable site storage and try again.');
    }

    function read(kind, key) {
        try { return storage(kind).getItem(key); }
        catch (_) {
            throw new Error('Browser storage is unavailable. Enable site storage and try again.');
        }
    }

    function write(kind, key, value) {
        try { storage(kind).setItem(key, JSON.stringify(value)); }
        catch (_) {
            throw new Error('Could not save to browser storage. Check site storage permissions and available space.');
        }
    }

    function normalizeUsername(value) {
        if (typeof value !== 'string') throw new Error('Enter a username.');
        const username = value.normalize('NFKC').trim();
        if (!/^[\p{L}\p{N}_ -]{2,20}$/u.test(username)) {
            throw new Error('Use 2–20 letters, numbers, spaces, underscores or hyphens for your username.');
        }
        return { username: username, nameKey: username.toLowerCase() };
    }

    function validatePassword(password) {
        if (typeof password !== 'string' || password.length < 4 || password.length > 128) {
            throw new Error('Use a password with 4–128 characters.');
        }
    }

    function readAccounts() {
        const raw = read('localStorage', accountsKey);
        if (raw === null) return { version: 1, accounts: [] };
        try {
            const data = JSON.parse(raw);
            if (!data || data.version !== 1 || !Array.isArray(data.accounts)) throw new Error();
            const names = new Set();
            for (const account of data.accounts) {
                if (!account || typeof account.username !== 'string') throw new Error();
                const name = normalizeUsername(account.username);
                if (name.username !== account.username || name.nameKey !== account.nameKey ||
                        names.has(account.nameKey) || !account.password ||
                        account.password.iterations !== iterations ||
                        !/^[a-f0-9]{32}$/.test(account.password.salt) ||
                        !/^[a-f0-9]{64}$/.test(account.password.hash)) throw new Error();
                names.add(account.nameKey);
            }
            return data;
        } catch (_) {
            // Never replace an unreadable account store with an empty one.
            throw new Error('Saved account data could not be read. Your existing data has not been changed.');
        }
    }

    function cryptoApi() {
        const api = window.crypto;
        if (!api || !api.subtle || !api.getRandomValues) {
            throw new Error('Secure password storage is unavailable. Open this game on localhost or HTTPS.');
        }
        return api;
    }

    function toHex(bytes) {
        return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    }

    function fromHex(value) {
        return new Uint8Array(value.match(/.{2}/g).map(byte => parseInt(byte, 16)));
    }

    async function hashPassword(password, salt) {
        const api = cryptoApi();
        const key = await api.subtle.importKey('raw', new TextEncoder().encode(password),
            'PBKDF2', false, ['deriveBits']);
        const result = await api.subtle.deriveBits({ name: 'PBKDF2', salt: fromHex(salt),
            iterations: iterations, hash: 'SHA-256' }, key, 256);
        return toHex(new Uint8Array(result));
    }

    function saveSession(account) {
        write('sessionStorage', sessionKey,
            { username: account.username, nameKey: account.nameKey });
        return { username: account.username };
    }

    async function register(username, password) {
        const name = normalizeUsername(username);
        validatePassword(password);
        const locks = window.navigator && window.navigator.locks;
        if (!locks || typeof locks.request !== 'function') {
            throw new Error('Registration is unavailable in this browser. Use current Chrome or Edge on localhost or HTTPS.');
        }
        // Serialize cooperating tabs through native hashing and the final read.
        // This mitigates the tested Chrome/Edge stale-read race; it is not a
        // formal localStorage visibility barrier. Never retry unlocked on failure.
        return locks.request(accountsKey, { mode: 'exclusive' }, async () => {
            if (readAccounts().accounts.some(account => account.nameKey === name.nameKey)) {
                throw new Error('That username is already registered. Choose another username or log in.');
            }
            const salt = toHex(cryptoApi().getRandomValues(new Uint8Array(16)));
            const hash = await hashPassword(password, salt);
            // Retain the fresh duplicate check after the required crypto await.
            const data = readAccounts();
            if (data.accounts.some(account => account.nameKey === name.nameKey)) {
                throw new Error('That username is already registered. Choose another username or log in.');
            }
            const account = { username: name.username, nameKey: name.nameKey,
                password: { salt: salt, hash: hash, iterations: iterations } };
            data.accounts.push(account);
            write('localStorage', accountsKey, data);
            try { return saveSession(account); }
            catch (_) {
                throw new Error('Your account was saved, but the login session could not be stored. Enable session storage and log in.');
            }
        });
    }

    async function login(username, password) {
        const name = normalizeUsername(username);
        validatePassword(password);
        const account = readAccounts().accounts.find(item => item.nameKey === name.nameKey);
        if (!account || await hashPassword(password, account.password.salt) !== account.password.hash) {
            throw new Error('Incorrect username or password.');
        }
        return saveSession(account);
    }

    function getSession() {
        try {
            const raw = read('sessionStorage', sessionKey);
            if (raw === null) return null;
            const session = JSON.parse(raw);
            if (!session || typeof session.nameKey !== 'string') return null;
            const account = readAccounts().accounts.find(item => item.nameKey === session.nameKey);
            return account ? { username: account.username } : null;
        } catch (_) {
            // A broken/blocked session must not prevent the home page loading.
            return null;
        }
    }

    function logout() {
        try { storage('sessionStorage').removeItem(sessionKey); }
        catch (_) { throw new Error('Could not clear the login session. Check site storage permissions.'); }
    }

    function isNameTaken(username) {
        const name = normalizeUsername(username);
        return readAccounts().accounts.some(account => account.nameKey === name.nameKey);
    }

    return Object.freeze({ register, login, getSession, logout, isNameTaken });
})();
