const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FileType = require('file-type');
const { sms, downloadMediaMessage } = require("./msg");

//=================VAR=================================//

// Replace the obfuscated import with your own functions
const connectdb = async (number) => {
  // Your existing MongoDB connection is already handled
  console.log(`✅ Connected to DB for ${number}`);
};

const input = async (settingType, newValue, number) => {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const currentConfig = await getUserConfigFromMongoDB(sanitizedNumber);
  currentConfig[settingType] = newValue;
  await updateUserConfigInMongoDB(sanitizedNumber, currentConfig);
};

const get = async (settingType, number) => {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const currentConfig = await getUserConfigFromMongoDB(sanitizedNumber);
  return currentConfig[settingType];
};

const getalls = async (number) => {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  return await getUserConfigFromMongoDB(sanitizedNumber);
};

const resetSettings = async (number) => {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  await updateUserConfigInMongoDB(sanitizedNumber, config);
};

//=================VAR=================================//

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('baileys');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'false',
    AUTO_LIKE_EMOJI: ['🖤', '🍬', '💫', '🎈', '💚', '🎶', '❤️', '🧫', '⚽'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/GoMNzlOXTDM9iEA17Pbgx5?mode=ems_copy_t',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: './solo-levelingg.jpg',
    NEWSLETTER_JID: '120363405217500077@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94767054052',
    DEV_MODE: 'false',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbAWWH9BFLgRMCXVlU38',
    WORK_TYPE: "public",
    ANTI_CAL: "off"
};

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://kaviduinduwara:kavidu2008@cluster0.bqmspdf.mongodb.net/soloBot?retryWrites=true&w=majority&appName=Cluster0';
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('✅ Connected to MongoDB');
}).catch(err => {
    console.error('❌ MongoDB connection error:', err);
});

// MongoDB Schemas
const sessionSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    creds: { type: Object, required: true },
    config: { type: Object, default: config },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const numberSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

const otpSchema = new mongoose.Schema({
    number: { type: String, required: true },
    otp: { type: String, required: true },
    newConfig: { type: Object },
    expiry: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now }
});

// MongoDB Models
const Session = mongoose.model('Session', sessionSchema);
const BotNumber = mongoose.model('BotNumber', numberSchema);
const OTP = mongoose.model('OTP', otpSchema);

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const otpStore = new Map();
const cleanupLocks = new Set();  // 🆕 ADD THIS LINE

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// ========== 🔍 IMPROVED MANUAL UNLINK DETECTION ========== //
function setupManualUnlinkDetection(socket, number) {
    let unlinkDetected = false;
    
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close' && !unlinkDetected) {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message;
            
            // Detect manual unlink (401 = logged out from another device)
            if (statusCode === 401 || errorMessage?.includes('401')) {
                unlinkDetected = true;
                console.log(`🔐 Manual unlink detected for ${number}`);
                
                // Clean up the session
                await handleManualUnlink(number);
            }
        }
    });
}

// Improved cleanup function
async function handleManualUnlink(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    // 🔒 Prevent duplicate cleanup
    if (cleanupLocks.has(sanitizedNumber)) {
        console.log(`⏩ Cleanup already in progress for ${sanitizedNumber}, skipping...`);
        return;
    }
    
    cleanupLocks.add(sanitizedNumber);
    
    try {
        console.log(`🔄 Cleaning up after manual unlink for ${sanitizedNumber}`);
        
        // Remove from active sockets
        if (activeSockets.has(sanitizedNumber)) {
            const socket = activeSockets.get(sanitizedNumber);
            socket.ev.removeAllListeners();
            activeSockets.delete(sanitizedNumber);
        }
        socketCreationTime.delete(sanitizedNumber);
        
        // Delete local session files
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            await fs.remove(sessionPath);
            console.log(`🗑️ Deleted local session after manual unlink for ${sanitizedNumber}`);
        }
        
        // Delete from MongoDB collections
        await Promise.all([
            Session.findOneAndDelete({ number: sanitizedNumber }),
            BotNumber.findOneAndDelete({ number: sanitizedNumber }),
            OTP.findOneAndDelete({ number: sanitizedNumber })
        ]);
        
        console.log(`✅ Completely cleaned up ${sanitizedNumber} from all collections`);
        
    } catch (error) {
        console.error(`Error cleaning up after manual unlink for ${sanitizedNumber}:`, error);
    } finally {
        // 🔓 Always release the lock
        cleanupLocks.delete(sanitizedNumber);
    }
}
// ========== END MANUAL UNLINK DETECTION ========== //

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

// MongoDB Session Management Functions
async function saveSessionToMongoDB(number, creds, userConfig = null) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        // Check if session already exists
        const existingSession = await Session.findOne({ number: sanitizedNumber });
        
        if (existingSession) {
            // Session exists - only update creds, don't show "saved" message
            await Session.findOneAndUpdate(
                { number: sanitizedNumber },
                { 
                    creds: creds,
                    updatedAt: new Date()
                }
            );
            console.log(`🔄 Session credentials updated for ${sanitizedNumber}`);
        } else {
            // New session - save everything
            const sessionData = {
                number: sanitizedNumber,
                creds: creds,
                config: userConfig || config,
                createdAt: new Date(),
                updatedAt: new Date()
            };

            await Session.findOneAndUpdate(
                { number: sanitizedNumber },
                sessionData,
                { upsert: true, new: true }
            );
            console.log(`✅ NEW Session saved to MongoDB for ${sanitizedNumber}`);
        }
    } catch (error) {
        console.error('❌ Failed to save/update session in MongoDB:', error);
        throw error;
    }
}

async function getSessionFromMongoDB(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({ number: sanitizedNumber });
        return session ? session.creds : null;
    } catch (error) {
        console.error('❌ Failed to get session from MongoDB:', error);
        return null;
    }
}

async function getUserConfigFromMongoDB(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({ number: sanitizedNumber });
        return session ? session.config : { ...config };
    } catch (error) {
        console.error('❌ Failed to get user config from MongoDB:', error);
        return { ...config };
    }
}

async function updateUserConfigInMongoDB(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.findOneAndUpdate(
            { number: sanitizedNumber },
            { 
                config: newConfig,
                updatedAt: new Date()
            }
        );
        console.log(`✅ Config updated in MongoDB for ${sanitizedNumber}`);
    } catch (error) {
        console.error('❌ Failed to update config in MongoDB:', error);
        throw error;
    }
}

async function deleteSessionFromMongoDB(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        // Delete from all collections
        await Promise.all([
            Session.findOneAndDelete({ number: sanitizedNumber }),
            BotNumber.findOneAndDelete({ number: sanitizedNumber }),
            OTP.findOneAndDelete({ number: sanitizedNumber })
        ]);
        
        console.log(`✅ Session completely deleted from MongoDB for ${sanitizedNumber}`);
    } catch (error) {
        console.error('❌ Failed to delete session from MongoDB:', error);
        throw error;
    }
}

async function addNumberToMongoDB(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await BotNumber.findOneAndUpdate(
            { number: sanitizedNumber },
            { number: sanitizedNumber, active: true },
            { upsert: true }
        );
        console.log(`✅ Number ${sanitizedNumber} added to MongoDB`);
    } catch (error) {
        console.error('❌ Failed to add number to MongoDB:', error);
        throw error;
    }
}

async function getAllNumbersFromMongoDB() {
    try {
        const numbers = await BotNumber.find({ active: true });
        return numbers.map(n => n.number);
    } catch (error) {
        console.error('❌ Failed to get numbers from MongoDB:', error);
        return [];
    }
}

async function saveOTPToMongoDB(number, otp, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const expiry = new Date(Date.now() + config.OTP_EXPIRY);
        
        await OTP.findOneAndUpdate(
            { number: sanitizedNumber },
            {
                number: sanitizedNumber,
                otp: otp,
                newConfig: newConfig,
                expiry: expiry
            },
            { upsert: true }
        );
        console.log(`✅ OTP saved to MongoDB for ${sanitizedNumber}`);
    } catch (error) {
        console.error('❌ Failed to save OTP to MongoDB:', error);
        throw error;
    }
}

async function verifyOTPFromMongoDB(number, otp) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const otpData = await OTP.findOne({ number: sanitizedNumber });
        
        if (!otpData) {
            return { valid: false, error: 'No OTP found' };
        }
        
        if (Date.now() > otpData.expiry.getTime()) {
            await OTP.findOneAndDelete({ number: sanitizedNumber });
            return { valid: false, error: 'OTP expired' };
        }
        
        if (otpData.otp !== otp) {
            return { valid: false, error: 'Invalid OTP' };
        }
        
        const configData = otpData.newConfig;
        await OTP.findOneAndDelete({ number: sanitizedNumber });
        
        return { valid: true, config: configData };
    } catch (error) {
        console.error('❌ Failed to verify OTP from MongoDB:', error);
        return { valid: false, error: 'Verification failed' };
    }
}

async function joinGroup(socket) {
    console.log('🔄 Checking group membership...');
    
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('❌ Invalid group invite link');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    
    const inviteCode = inviteCodeMatch[1];
    let retries = 3;

    // Check if already in group
    try {
        const groupInfo = await socket.groupGetInviteInfo(inviteCode);
        if (groupInfo && groupInfo.id) {
            console.log(`🔍 Found group: ${groupInfo.id}`);
            
            try {
                const groupMetadata = await socket.groupMetadata(groupInfo.id);
                const isMember = groupMetadata.participants?.some(p => p.id === socket.user.id);
                
                if (isMember) {
                    console.log(`✅ Already in group`);
                    return { status: 'already_member', gid: groupInfo.id };
                }
            } catch (metaError) {
                // Silent fail - just try to join
            }
        }
    } catch (infoError) {
        console.log('❌ Cannot access group');
        return { status: 'failed', error: 'Cannot access group' };
    }

    // Join the group
    console.log(`🔄 Joining group...`);
    
    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            
            if (response?.gid) {
                console.log(`✅ Joined group: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            
            // Wait and verify
            await delay(2000);
            
            try {
                const groupInfo = await socket.groupGetInviteInfo(inviteCode);
                if (groupInfo && groupInfo.id) {
                    console.log(`✅ Joined successfully`);
                    return { status: 'success', gid: groupInfo.id };
                }
            } catch (verifyError) {
                // Silent verification fail
            }
            
            retries--;
            if (retries > 0) await delay(2000);
            
        } catch (error) {
            retries--;
            
            if (error.message.includes('conflict') || error.message.includes('already')) {
                console.log('✅ Already in group');
                return { status: 'already_member', error: 'Already member' };
            }
            else if (error.message.includes('not-authorized')) {
                console.log('❌ Not authorized to join');
                return { status: 'failed', error: 'Not authorized' };
            }
            else if (error.message.includes('gone')) {
                console.log('❌ Link expired');
                return { status: 'failed', error: 'Link expired' };
            }
            else if (error.message.includes('full')) {
                console.log('❌ Group full');
                return { status: 'failed', error: 'Group full' };
            }
            
            if (retries === 0) {
                console.log('❌ Failed to join group');
                return { status: 'failed', error: error.message };
            }
            
            await delay(2000);
        }
    }
    
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '⛩️ 𝘾𝙊𝙉𝙉𝙀𝘾𝙏 𝙏𝙊 𝙎𝙊𝙇𝙊 𝙇𝙀𝙑𝙀𝙇𝙄𝙉𝙂 𝙓  𝙁𝙍𝙀𝙀 𝙈𝙄𝙉𝙄 𝘽𝙊𝙏 🚀',
        `📞 Number: ${number}\n🩵 Status: Connected\n\n> FOLLOW CHENNEL :- https://whatsapp.com/channel/0029VbAWWH9BFLgRMCXVlU38`,
        '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function safeJSONParse(str, defaultValue = {}) {
    try {
        if (!str || str.trim() === '') return defaultValue;
        // Remove any invalid characters before parsing
        const cleanStr = str.replace(/[^\x20-\x7E]/g, '');
        return JSON.parse(cleanStr);
    } catch (error) {
        console.error('❌ JSON parse failed:', error.message, 'Input:', str?.substring(0, 100));
        return defaultValue;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        // 🆕 CHECK IF IT'S A COMMAND FIRST
        let body = '';
        try {
            if (message.message?.conversation) {
                body = message.message.conversation;
            } else if (message.message?.extendedTextMessage?.text) {
                body = message.message.extendedTextMessage.text;
            }
            
            // If it's a command, check if it's allowed
            if (body.startsWith(config.PREFIX)) {
                const command = body.slice(config.PREFIX.length).trim().split(' ')[0].toLowerCase();
                const allowedChannelCommands = ['checkjid', 'ping']; // Same as in command handler
                
                // 🟢 Only skip reactions for NON-allowed commands
                if (!allowedChannelCommands.includes(command)) {
                    console.log(`🔍 Command ${command} not allowed in channel - skipping reaction`);
                    return; // Skip reaction for non-allowed commands
                }
                // 🟢 For allowed commands, CONTINUE and do reaction
                console.log(`✅ Allowed command ${command} in channel - will react`);
            }
        } catch (error) {
            // If we can't extract body, continue with reactions
        }

        // 🟢 Do reactions for:
        // 1. Normal messages
        // 2. ALLOWED commands (checkjid, ping)
        try {
            const emojis = ['💜', '🔥', '💫', '👍', '🧧'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

async function getSessionStatus(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const existingSession = await Session.findOne({ number: sanitizedNumber });
    const isActive = activeSockets.has(sanitizedNumber);
    
    return {
        exists: !!existingSession,
        isActive: isActive,
        createdAt: existingSession?.createdAt,
        updatedAt: existingSession?.updatedAt
    };
}

async function loadConfig(number) {
    try {
        const settings = await getalls(number); 
        if (settings) {
            // Return user config instead of modifying global config
            return settings;
        } else {
            console.warn(`No settings found for number: ${number}`);
            return { ...config }; // Return default config
        }
    } catch (error) {
        console.error('Error loading config:', error);
        return { ...config }; // Return default config on error
    }
}

async function setupStatusHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            // Load user-specific config from database
            const userConfig = await getUserConfigFromMongoDB(number);
            
            if (userConfig.AUTO_VIEW_STATUS === 'true') {
                let retries = userConfig.MAX_RETRIES || config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status for ${number}, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (userConfig.AUTO_LIKE_STATUS === 'true') {
                // Use user-specific emojis from database
                const userEmojis = userConfig.AUTO_LIKE_EMOJI || config.AUTO_LIKE_EMOJI;
                const randomEmoji = userEmojis[Math.floor(Math.random() * userEmojis.length)];
                
                let retries = userConfig.MAX_RETRIES || config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji} for user ${number}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status for ${number}, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error(`Status handler error for ${number}:`, error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function oneViewmeg(socket, isOwner, msg ,sender) {
    if (isOwner) {  
    try {
    const akuru = sender
    const quot = msg
    if (quot) {
        if (quot.imageMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
            await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
        } else if (quot.videoMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
             await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
        } else if (quot.audioMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.audioMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.audioMessage);
             await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        } else if (quot.viewOnceMessageV2?.message?.imageMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
             await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
            
        } else if (quot.viewOnceMessageV2?.message?.videoMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
            await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });

        } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
        
            let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
            await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        }
        }        
        } catch (error) {
      }
    }
}

const handleSettingUpdate = async (settingType, newValue, reply, number) => {
  const currentValue = await get(settingType, number);
  var alreadyMsg = "*This setting alredy updated !*";
  if (currentValue === newValue) {
    return await reply(alreadyMsg);
  }
  await input(settingType, newValue, number);
  await reply(`➟ *${settingType.replace(/_/g, " ").toUpperCase()} updated: ${newValue}*`);
};

const updateSetting = async (settingType, newValue, reply, number) => {
  const currentValue = await get(settingType, number);
  if (currentValue === newValue) {
   var alreadyMsg = "*This setting alredy updated !*";
    return await reply(alreadyMsg);
  }
  await input(settingType, newValue, number);
  await reply(`➟ *${settingType.replace(/_/g, " ").toUpperCase()} updated: ${newValue}*`);
};

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        
        loadConfig(number).catch(console.error);
        const type = getContentType(msg.message);
        if (!msg.message) return;
        
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
            ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
            : [];
        
        // FIXED: Better message body extraction with proper type checking
        let body = '';
        try {
            if (type === 'conversation') {
                body = msg.message.conversation || '';
            } else if (type === 'extendedTextMessage') {
                body = msg.message.extendedTextMessage?.text || '';
            } else if (type === 'imageMessage') {
                body = msg.message.imageMessage?.caption || '';
            } else if (type === 'videoMessage') {
                body = msg.message.videoMessage?.caption || '';
            } else if (type === 'interactiveResponseMessage') {
                const nativeFlow = msg.message.interactiveResponseMessage?.nativeFlowResponseMessage;
                if (nativeFlow) {
                    try {
                        const params = safeJSONParse(nativeFlow.paramsJson, {});
                        body = params.id || '';
                    } catch (e) {
                        body = '';
                    }
                }
            } else if (type === 'templateButtonReplyMessage') {
                body = msg.message.templateButtonReplyMessage?.selectedId || '';
            } else if (type === 'buttonsResponseMessage') {
                body = msg.message.buttonsResponseMessage?.selectedButtonId || '';
            } else if (type === 'listResponseMessage') {
                body = msg.message.listResponseMessage?.singleSelectReply?.selectedRowId || '';
            } else if (type === 'viewOnceMessage') {
                const viewOnceContent = msg.message[type]?.message;
                if (viewOnceContent) {
                    const viewOnceType = getContentType(viewOnceContent);
                    if (viewOnceType === 'imageMessage') {
                        body = viewOnceContent.imageMessage?.caption || '';
                    } else if (viewOnceType === 'videoMessage') {
                        body = viewOnceContent.videoMessage?.caption || '';
                    }
                }
            } else if (type === "viewOnceMessageV2") {
                body = msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";
            }
            
            // Ensure body is always a string
            body = String(body || '');
            
        } catch (error) {
            console.error('Error extracting message body:', error);
            body = '';
        }
        
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        var prefix = config.PREFIX;
        
        // FIXED: Add proper type checking for startsWith
        var isCmd = false;
        if (typeof body === 'string' && body.trim()) {
            isCmd = body.startsWith(prefix);
        }
        
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        var args = body.trim().split(/ +/).slice(1);

        // 🆕 ADD THIS BLOCK RIGHT HERE
const isChannel = msg.key.remoteJid.endsWith('@newsletter');

if (isChannel && isCmd) {  // 🟢 Only run if it's actually a command
    const allowedChannelCommands = ['checkjid', 'ping'];
    
    if (!allowedChannelCommands.includes(command)) {
        console.log(`🚫 Command ${command} not allowed in channels`);
        return; // Block the command
    }
    
    console.log(`✅ Processing ${command} in channel`);
}
// 🆕 END OF ADDED BLOCK
        
        const reply = async(teks) => {
            return await socket.sendMessage(sender, { text: teks }, { quoted: msg });
        };
        
        // Only log commands, not all messages (COMMENTED DEBUG LOGGING)
// console.log('Message received:', {
//     type: type,
//     body: body,
//     bodyType: typeof body,
//     isCmd: isCmd,
//     command: command
// });
        
        // settings tika
        // With this:
const userConfig = await getUserConfigFromMongoDB(number);
const presence = userConfig.PRESENCE;
if (msg.key.remoteJid) {
    if (presence && presence !== "available") {
        await socket.sendPresenceUpdate(presence, msg.key.remoteJid);
    } else {
        await socket.sendPresenceUpdate("available", msg.key.remoteJid);
    }
}
        
if (!isOwner && userConfig.WORK_TYPE === "private") return;
if (!isOwner && isGroup && userConfig.WORK_TYPE === "inbox") return;
if (!isOwner && !isGroup && userConfig.WORK_TYPE === "groups") return;

        // FIXED: Add proper FileType import for downloadAndSaveMediaMessage
        const FileType = require('file-type');
        socket.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            let trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };
        
        if (!command || command === '.') return;
        
        let pinterestCache = {};

        try {
            switch (command) {
                case 'button': {
                    const buttons = [
                        {
                            buttonId: `${config.PREFIX}menu`,
                            buttonText: { displayText: 'MENU' },
                            type: 1
                        },
                        {
                            buttonId: `${config.PREFIX}alive`,
                            buttonText: { displayText: 'Alive' },
                            type: 1
                        }
                    ];

                    const captionText = '𝙎𝙊𝙇𝙊 𝙇𝙀𝙑𝙀𝙇𝙄𝙉𝙂 𝙓 𝙈𝙄𝙉𝙄';
                    const footerText = '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈';

                    const buttonMessage = {
                        image: { url: "https://files.catbox.moe/kd95jb.jpg" },
                        caption: captionText,
                        footer: footerText,
                        buttons,
                        headerType: 1
                    };

                    await socket.sendMessage(from, buttonMessage, { quoted: msg });
                    break;
                }
                
                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    const channelStatus = config.NEWSLETTER_JID ? '✅ Followed' : '❌ Not followed';

                    const captionText = `
╭─── 〘⛩️ LEGION OF DOOM ⛩️〙 ───────
│
│ ⛩️ 𝙎𝙊𝙇𝙊 𝙇𝙀𝙑𝙀𝙇𝙄𝙉𝙂 𝙓  𝙁𝙍𝙀𝙀 𝙈𝙄𝙉𝙄 𝘽𝙊𝙏 
│ 🌐 Version: 𝚂𝙾𝙇𝙊 𝙻𝙴𝚅𝙴𝙻𝙸𝙽𝙂 𝚇 𝙼𝙸𝙉𝙄
│ 🤖 Owner : Dinu ID & D Rukshan
│
╭─── 〘⛩️ SESSION INFO ⛩️〙 ─────────
│
│ ⏰ Bot Uptime: ${hours}h ${minutes}m ${seconds}s
│ 🟢 Active session: ${activeSockets.size}
│ 📞 Your Number: ${number}
│ 📢 Channel: ${channelStatus}
│
╭─── 〘 🛠️ COMMANDS 〙 ────────────
│
│ ${config.PREFIX}menu  -  Watch all command
│ ${config.PREFIX}deleteme - Delete session
│ ${config.PREFIX}ping   - Bot life testing
│ ${config.PREFIX}status - Latest updates
│ ${config.PREFIX}owner - Bot developed
│ ${config.PREFIX}runtime - Total runtime
│ ${config.PREFIX}ping - Ping test
│
╭─── 〘 🌐 LINKS 〙 ─────────────────
│
│ 🔗 Main Website:
│ https://free-bot-website-mega-by-lod.vercel.app/
│
╰────────────────────────────────
`;

                    const templateButtons = [
                        {
                            buttonId: `${config.PREFIX}menu`,
                            buttonText: { displayText: 'MENU' },
                            type: 1,
                        },
                        {
                            buttonId: `${config.PREFIX}owner`,
                            buttonText: { displayText: 'OWNER' },
                            type: 1,
                        },
                        {
                            buttonId: 'action',
                            buttonText: {
                                displayText: '📂 Menu Options'
                            },
                            type: 4,
                            nativeFlowInfo: {
                                name: 'single_select',
                                paramsJson: JSON.stringify({
                                    title: 'Click Here ❏',
                                    sections: [
                                        {
                                            title: `𝙎𝙊𝙇𝙊 𝙇𝙀𝙑𝙀𝙇𝙄𝙉𝙂 𝙓 𝙈𝙄𝙉𝙄`,
                                            highlight_label: '',
                                            rows: [
                                                {
                                                    title: 'MENU 📌',
                                                    description: '𝙎𝙊𝙇𝙊 𝙇𝙀𝙑𝙀𝙇𝙄𝙉𝙂 𝙓 𝙈𝙄𝙉𝙄',
                                                    id: `${config.PREFIX}menu`,
                                                },
                                                {
                                                    title: 'OWNER 📌',
                                                    description: '𝙎𝙊𝙇𝙊 𝙇𝙀𝙑𝙀𝙇𝙄𝙉𝙂 𝙓 𝙈𝙄𝙉𝙄',
                                                    id: `${config.PREFIX}owner`,
                                                },
                                            ],
                                        },
                                    ],
                                }),
                            },
                        }
                    ];

try {
        await socket.sendMessage(m.chat, {
            buttons: templateButtons,
            headerType: 1,
            viewOnce: true,
            image: { url: "./solo-levelingg.jpg" }, // Local file instead of URL
            caption: `𝚂𝙾𝙻𝙾 𝙻𝙴𝚅𝙴𝙻𝙸𝙽𝙶 𝚇 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃 𝙰𝙻𝙸𝚅𝙴 𝙽𝙾𝚆\n\n${captionText}`,
        }, { quoted: msg });
    } catch (error) {
        console.error(`Failed to send image for alive command (${number}):`, error.message);
        // Fallback to text
        await socket.sendMessage(m.chat, {
            text: `𝚂𝙾𝙻𝙾 𝙻𝙴𝚅𝙴𝙻𝙸𝙽𝙶 𝚇 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃 𝙰𝙻𝙸𝚅𝙴 𝙽𝙾𝚆\n\n${captionText}`
        }, { quoted: msg });
    }
    break;
}

                case 'menu': {
                    const menuText = `
╭─── 📝 *COMMAND MENU* ────
│ ${config.PREFIX}alive  - Bot status
│ ${config.PREFIX}owner  - Owner info
│ ${config.PREFIX}ping   - Ping test
│ ${config.PREFIX}deleteme - Delete your session
│ ${config.PREFIX}nasa   - NASA image of the day
│ ${config.PREFIX}song   - Download YouTube audio
│ ${config.PREFIX}winfo  - WhatsApp info
╰────────────────────────
                    `;
                    await socket.sendMessage(sender, { text: menuText }, { quoted: msg });
                    break;
                }
                case 'owner': {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: `👑 *Bot Owner:* ${config.OWNER_NUMBER}\n📢 Channel: ${config.CHANNEL_LINK}`
                    }, { quoted: msg });
                    break;
                }
                case 'nasa':
                    try {
                        const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=8vhAFhlLCDlRLzt5P1iLu2OOMkxtmScpO5VmZEjZ');
                        if (!response.ok) {
                            throw new Error('Failed to fetch APOD from NASA API');
                        }
                        const data = await response.json();

                        if (!data.title || !data.explanation || !data.date || !data.url || data.media_type !== 'image') {
                            throw new Error('Invalid APOD data received or media type is not an image');
                        }

                        const { title, explanation, date, url, copyright } = data;
                        const thumbnailUrl = url || 'https://via.placeholder.com/150';

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '🌌 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐊𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈 𝐍𝐀𝐒𝐀 𝐍𝐄𝐖𝐒',
                                `🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *Date*: ${date}\n${copyright ? `📝 *Credit*: ${copyright}` : ''}\n🔗 *Link*: https://apod.nasa.gov/apod/astropix.html`,
                                '> 𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
                            )
                        });

                    } catch (error) {
                        console.error(`Error in 'apod' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ ඕවා බලන්න ඕනි නැ ගිහින් නිදාගන්න'
                        });
                    }
                    break;
                                case 'cricket':
                    try {
                        console.log('Fetching cricket news from API...');
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
                        console.log(`API Response Status: ${response.status}`);

                        if (!response.ok) {
                            throw new Error(`API request failed with status ${response.status}`);
                        }

                        const data = await response.json();
                        console.log('API Response Data:', JSON.stringify(data, null, 2));

                        if (!data.status || !data.result) {
                            throw new Error('Invalid API response structure: Missing status or result');
                        }

                        const { title, score, to_win, crr, link } = data.result;
                        if (!title || !score || !to_win || !crr || !link) {
                            throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
                        }

                        console.log('Sending message to user...');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🏏 SOLO LEVELING X MINI CRICKET NEWS🏏',
                                `📢 *${title}*\n\n` +
                                `🏆 *Mark*: ${score}\n` +
                                `🎯 *To Win*: ${to_win}\n` +
                                `📈 *Current Rate*: ${crr}\n\n` +
                                `🌐 *Link*: ${link}`,
                                '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
                            )
                        });
                        console.log('Message sent successfully.');
                    } catch (error) {
                        console.error(`Error in 'cricket' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ හා හා Cricket ඕනේ නෑ ගිහින් වෙන මොකක් හරි බලන්න.'
                        });
                    }
                    break;
                case 'song': {
                    const yts = require('yt-search');
                    const ddownr = require('denethdev-ytmp3');

                    function extractYouTubeId(url) {
                        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
                        const match = url.match(regex);
                        return match ? match[1] : null;
                    }

                    function convertYouTubeLink(input) {
                        const videoId = extractYouTubeId(input);
                        if (videoId) {
                            return `https://www.youtube.com/watch?v=${videoId}`;
                        }
                        return input;
                    }

                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || '';

                    if (!q || q.trim() === '') {
                        return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
                    }

                    const fixedQuery = convertYouTubeLink(q.trim());

                    try {
                        const search = await yts(fixedQuery);
                        const data = search.videos[0];
                        if (!data) {
                            return await socket.sendMessage(sender, { text: '*`No results found`*' });
                        }

                        const url = data.url;
                        const desc = `
🎵 *𝚃𝚒𝚝𝚕𝚎 :* \`${data.title}\`

◆⏱️ *𝙳𝚞𝚛𝚊𝚝𝚒𝚘𝚗* : ${data.timestamp} 

◆ *𝚅𝚒𝚎𝚠𝚜* : ${data.views}

◆ 📅 *𝚁𝚎𝚕𝚎𝚊𝚜 𝙳𝚊𝚝𝚎* : ${data.ago}
`;

                        await socket.sendMessage(sender, {
                            image: { url: data.thumbnail },
                            caption: desc,
                        }, { quoted: msg });

                        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

                        const result = await ddownr.download(url, 'mp3');
                        const downloadLink = result.downloadUrl;

                        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

                        await socket.sendMessage(sender, {
                            audio: { url: downloadLink },
                            mimetype: "audio/mpeg",
                            ptt: true
                        }, { quoted: msg });
                    } catch (err) {
                        console.error(err);
                        await socket.sendMessage(sender, { text: "*`Error occurred while downloading`*" });
                    }
                    break;
                }
                case 'winfo':
                    console.log('winfo command triggered for:', number);
                    if (!args[0]) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'Please provide a phone number! Usage: .winfo +94xxxxxxxxx',
                                '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
                            )
                        });
                        break;
                    }

                    let inputNumber = args[0].replace(/[^0-9]/g, '');
                    if (inputNumber.length < 10) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'Invalid phone number! Please include country code (e.g., +94712345678)',
                                '> 𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
                            )
                        });
                        break;
                    }

                    let winfoJid = `${inputNumber}@s.whatsapp.net`;
                    const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                    if (!winfoUser?.exists) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'User not found on WhatsApp',
                                '> 𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
                            )
                        });
                        break;
                    }

                    let winfoPpUrl;
                    try {
                        winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                    } catch {
                        winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
                    }

                    let winfoName = winfoJid.split('@')[0];
                    try {
                        const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                        if (presence?.pushName) winfoName = presence.pushName;
                    } catch (e) {
                        console.log('Name fetch error:', e);
                    }

                    let winfoBio = 'No bio available';
                    try {
                        const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                        if (statusData?.status) {
                            winfoBio = `${statusData.status}\n└─ 📌 Updated: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }) : 'Unknown'}`;
                        }
                    } catch (e) {
                        console.log('Bio fetch error:', e);
                    }

                    let winfoLastSeen = '❌ 𝐍𝙾𝚃 𝐅𝙾𝚄𝙽𝙳';
                    try {
                        const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                        if (lastSeenData?.lastSeen) {
                            winfoLastSeen = `🕒 ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}`;
                        }
                    } catch (e) {
                        console.log('Last seen fetch error:', e);
                    }

                    const userInfoWinfo = formatMessage(
                        '🔍 PROFILE INFO',
                        `> *Number:* ${winfoJid.replace(/@.+/, '')}\n\n> *Account Type:* ${winfoUser.isBusiness ? '💼 Business' : '👤 Personal'}\n\n*📝 About:*\n${winfoBio}\n\n*🕒 Last Seen:* ${winfoLastSeen}`,
                        '> 𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
                    );

                    await socket.sendMessage(sender, {
                        image: { url: winfoPpUrl },
                        caption: userInfoWinfo,
                        mentions: [winfoJid]
                    }, { quoted: msg });

                    console.log('User profile sent successfully for .winfo');
                    break;
                case 'ig': {
                    const axios = require('axios');
                    const { igdl } = require('ruhend-scraper'); 

                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const igUrl = q?.trim(); 
                    
                    if (!/instagram\.com/.test(igUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *Please provide a valid Instagram video link.*' });
                    }

                    try {
                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        const res = await igdl(igUrl);
                        const data = res.data; 

                        if (data && data.length > 0) {
                            const videoUrl = data[0].url; 

                            await socket.sendMessage(sender, {
                                video: { url: videoUrl },
                                mimetype: 'video/mp4',
                                caption: '> 𝙎𝙊𝙇𝙊 𝙇𝙀𝙑𝙀𝙇𝙄𝙉𝙂 𝙓 𝙈𝙄𝙉𝙄'
                            }, { quoted: msg });

                            await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                        } else {
                            await socket.sendMessage(sender, { text: '*❌ No video found in the provided link.*' });
                        }

                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ Error downloading Instagram video.*' });
                    }

                    break;
                }
                case 'deleteme':
    try {
        if (!isOwner) {
            return await reply("🚫 *You are not authorized to use this command!*");
        }

        const sanitizedNumber = number.replace(/[^0-9]/g, '');

        // Step 1: Send initial response
        await socket.sendMessage(sender, {
            text: "🔄 *Starting session deletion process...*"
        });
        await delay(1000);

        // Step 2: Send FINAL message
        await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: formatMessage(
                '🗑️ SESSION DELETION IN PROGRESS',
                `Your session is being deleted...\n\n` +
                `✅ Connection will close\n` +
                `✅ All data will be cleared\n` +
                `✅ You'll need to scan a new QR code\n\n` +
                `🔗 *Website:* https://free-bot-website-mega-by-lod.vercel.app/`,
                '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
            )
        });

        // Step 3: Wait to ensure final message is delivered
        await delay(2000);

        // Step 4: CLOSE CONNECTION FIRST
        console.log(`🔌 Closing WebSocket connection for ${sanitizedNumber}...`);
        try {
            await socket.ws.close();
            socket.ev.removeAllListeners();
            console.log(`✅ WebSocket connection closed for ${sanitizedNumber}`);
        } catch (closeError) {
            console.log(`⚠️ Could not close WebSocket: ${closeError.message}`);
            if (socket.ws) socket.ws.terminate();
        }

        // Step 5: Remove from tracking
        if (activeSockets.has(sanitizedNumber)) {
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
        }

        // Step 6: Wait for connection to fully close
        await delay(1000);

        // Step 7: NOW delete data (no more mutation errors)
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            await fs.remove(sessionPath);
            console.log(`🗑️ Local session deleted for ${sanitizedNumber}`);
        }

        await deleteSessionFromMongoDB(sanitizedNumber);
        console.log(`🗑️ Database records deleted for ${sanitizedNumber}`);

        console.log(`🎯 Session deletion COMPLETED for ${sanitizedNumber}`);

    } catch (error) {
        console.error('Deleteme command error:', error);
    }
    break;

             case "setting": {
  try {
    if (!isOwner) {
      return await reply("🚫 *You are not authorized to use this command!*");
    }

    const settingOptions = {
      name: 'single_select',
      paramsJson: JSON.stringify({
        title: '🔧 𝙎𝙊𝙇𝙊 𝙇𝙀𝙑𝙀𝙇𝙄𝙉𝙂 𝙓 𝙈𝙄𝙉𝙄 𝙎𝙀𝙏𝙏𝙄𝙉𝙂',
        sections: [
          {
            title: '➤ 𝐖𝙾𝚁𝙺 𝐓𝚈𝙿𝙴',
            rows: [
              { title: '𝐏𝚄𝙱𝙻𝙸𝙲', description: '', id: `${prefix}wtype public` },
              { title: '𝐎𝙽𝙻𝚈 𝐆𝚁𝙾𝚄𝙿', description: '', id: `${prefix}wtype groups` },
              { title: '𝐎𝙽𝙻𝚈 𝐈𝙽𝙱𝙾𝚇', description: '', id: `${prefix}wtype inbox` },
              { title: '𝐎𝙽𝙻𝚈 𝐏𝚁𝙸𝚅𝙰𝚃𝙴', description: '', id: `${prefix}wtype private` },
            ],
          },
          {
            title: '➤ 𝐅𝙰𝙺𝙴 𝐑𝙴𝙲𝙾𝙳𝙸𝙽𝙶 & 𝐓𝚈𝙿𝙴𝙸𝙽𝙶',
            rows: [
              { title: '𝐀𝚄𝚃𝙾 𝐓𝚈𝙿𝙸𝙽𝙶', description: '', id: `${prefix}wapres composing` },
              { title: '𝐀𝚄𝚃𝙾 𝐑𝙴𝙲𝙾𝚁𝙳𝙸𝙽𝙶', description: '', id: `${prefix}wapres recording` },
            ],
          },
          {
            title: '➤ 𝐀𝙻𝙻𝚆𝙰𝚈𝚂 𝐎𝙽𝙻𝙸𝙽𝙴',
            rows: [
              { title: '𝐀𝙻𝙻𝚆𝙰𝚈𝚂 𝐎𝙽𝙻𝙸𝙽𝙴 𝐎𝙵𝙵', description: '', id: `${prefix}wapres unavailable` },
              { title: '𝐀𝙻𝙻𝚆𝙰𝚈𝚂 𝐎𝙽𝙻𝙸𝙽𝙴 𝐎𝙽', description: '', id: `${prefix}wapres available` },
            ],
          },
          {
            title: '➤ 𝐀𝚄𝚃𝙾 𝐒𝚃𝙰𝚃𝚄𝚂 𝐒𝙴𝙴𝙽',
            rows: [
              { title: '𝐒𝚃𝙰𝚃𝚄𝚂 𝐒𝙴𝙴𝙽 𝐎𝙽', description: '', id: `${prefix}rstatus on` },
              { title: '𝐒𝚃𝙰𝚃𝚄𝚂 𝐒𝙴𝙴𝙽 𝐎𝙵𝙵', description: '', id: `${prefix}rstatus off` },
            ],
          },
          {
            title: '➤ 𝐀𝚄𝚃𝙾 𝐒𝚃𝙰𝚃𝚄𝚂 𝐑𝙴𝙰𝙲𝚃',
            rows: [
              { title: '𝐒𝚃𝙰𝚃𝚄𝚂 𝐑𝙴𝙰𝙲𝚃 𝐎𝙽', description: '', id: `${prefix}arm on` },
              { title: '𝐒𝚃𝙰𝚃𝚄𝚂 𝐑𝙴𝙰𝙲𝚃 𝐎𝙵𝙵', description: '', id: `${prefix}arm off` },
            ],
          }, 
          {
            title: '➤ 𝐀𝚄𝚃𝙾 𝐑𝙴𝙹𝙴𝙲𝚃 𝐂𝙰𝙻𝙻',
            rows: [
              { title: '𝐀𝚄𝚃𝙾 𝐑𝙴𝙹𝙴𝙲𝚃 𝐂𝙰𝙻𝙻 𝐎𝙽', description: '', id: `${prefix}creject on` },
              { title: '𝐀𝚄𝚃𝙾 𝐑𝙴𝙹𝙴𝙲𝚃 𝐂𝙰𝙻𝙻 𝐎𝙵𝙵', description: '', id: `${prefix}creject off` },
            ],
          },
          {
            title: '➤ 𝐀𝚄𝚃𝙾 𝐌𝙰𝚂𝚂𝙰𝙶𝙴 𝐑𝙴𝙰𝙳',
            rows: [
              { title: '𝐑𝙴𝙰𝙳 𝐀𝙻𝙻 𝐌𝙰𝚂𝚂𝙰𝙶𝙴𝚂', description: '', id: `${prefix}mread all` },
              { title: '𝐑𝙴𝙰𝙳 𝐀𝙻𝙻 𝐌𝙰𝚂𝚂𝙰𝙶𝙴𝚂 𝐂𝙾𝙼𝙼𝙰𝙽𝙳𝚂', description: '', id: `${prefix}mread cmd` },
              { title: '𝐃𝙾𝙽𝚃 𝐑𝙴𝙰𝙳 𝐀𝙽𝚈 𝐌𝙰𝚂𝚂𝙰𝙶𝙴', description: '', id: `${prefix}mread off` },
            ],
          },
        ],
      }),
    };

    // Get current settings from MongoDB
    const currentConfig = await getUserConfigFromMongoDB(number);
    
    await socket.sendMessage(m.chat, {
      headerType: 1,
      viewOnce: true,
      image: { url: config.RCD_IMAGE_PATH },
      caption: `╭────────────╮\nUPDATE SETTING NOT WATCH\n╰────────────╯\n\n` +
        `┏━━━━━━━━━━◆◉◉➤\n` +
        `┃◉ *WORK TYPE:* ${currentConfig.WORK_TYPE || 'public'}\n` +
        `┃◉ *BOT PRESENCE:* ${currentConfig.PRESENCE || 'available'}\n` +
        `┃◉ *AUTO STATUS SEEN:* ${currentConfig.AUTO_VIEW_STATUS || 'true'}\n` +
        `┃◉ *AUTO STATUS REACT:* ${currentConfig.AUTO_LIKE_STATUS || 'true'}\n` +
        `┃◉ *AUTO REJECT CALL:* ${currentConfig.ANTI_CALL || 'off'}\n` +
        `┃◉ *AUTO MESSAGE READ:* ${currentConfig.AUTO_READ_MESSAGE || 'off'}\n` +
        `┗━━━━━━━━━━◆◉◉➤`,
      buttons: [
        {
          buttonId: 'settings_action',
          buttonText: { displayText: '⚙️ Configure Settings' },
          type: 4,
          nativeFlowInfo: settingOptions,
        },
      ],
      footer: '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈',
    }, { quoted: msg });
  } catch (e) {
    console.error('Setting command error:', e);
    await reply("*❌ Error loading settings!*");
  }
  break;
}

case "emojis": {
  await socket.sendMessage(sender, { react: { text: '🎭', key: msg.key } });
  try {
    if (!isOwner) 
      return await reply("🚫 *You are not authorized to use this command!*");
    
    let newEmojis = args;
    
    if (!newEmojis || newEmojis.length === 0) {
      // Show current emojis if no args provided
      const userConfig = await getUserConfigFromMongoDB(number);
      const currentEmojis = userConfig.AUTO_LIKE_EMOJI || config.AUTO_LIKE_EMOJI;
      return await reply(`🎭 *Current Status Reaction Emojis:*\n\n${currentEmojis.join(' ')}\n\nUsage: \`.emojis 😀 😄 😊 🎉 ❤️\``);
    }
    
    // Validate emojis (basic check)
    const invalidEmojis = newEmojis.filter(emoji => !/\p{Emoji}/u.test(emoji));
    if (invalidEmojis.length > 0) {
      return await reply(`❌ *Invalid emojis detected:* ${invalidEmojis.join(' ')}\n\nPlease use valid emoji characters only.`);
    }
    
    // Get user-specific config from MongoDB
    const userConfig = await getUserConfigFromMongoDB(number);
    
    // Update ONLY this user's emojis
    userConfig.AUTO_LIKE_EMOJI = newEmojis;
    
    // Save to MongoDB
    await updateUserConfigInMongoDB(number, userConfig);
    
    await reply(`✅ *Your Status Reaction Emojis Updated!*\n\nNew emojis: ${newEmojis.join(' ')}\n\nThese emojis will be used for your automatic status reactions.`);
    
  } catch (e) {
    console.error('Emojis command error:', e);
    await reply("*❌ Error updating your status reaction emojis!*");
  }
  break;
}

case 'checkjid': {
    try {
        if (!isOwner) {
            return await reply("🚫 *You are not authorized to use this command!*");
        }

        const target = args[0] || sender;
        let targetJid = target;

        // If it's not a full JID, try to format it
        if (!target.includes('@')) {
            if (target.includes('-')) {
                // Likely a group ID
                targetJid = target.endsWith('@g.us') ? target : `${target}@g.us`;
            } else if (target.length > 15) {
                // Likely a newsletter ID
                targetJid = target.endsWith('@newsletter') ? target : `${target}@newsletter`;
            } else {
                // Likely a user number
                targetJid = target.endsWith('@s.whatsapp.net') ? target : `${target}@s.whatsapp.net`;
            }
        }

        let type = 'Unknown';

        // Determine JID type
        if (targetJid.endsWith('@g.us')) {
            type = 'Group';
        } else if (targetJid.endsWith('@newsletter')) {
            type = 'Newsletter';
        } else if (targetJid.endsWith('@s.whatsapp.net')) {
            type = 'User';
        } else if (targetJid.endsWith('@broadcast')) {
            type = 'Broadcast List';
        } else {
            type = 'Unknown';
        }

        // Simple formatted output
        const responseText = `🔍 *JID INFORMATION*\n\n📌 *Type:* ${type}\n🆔 *JID:* ${targetJid}\n\n╰──────────────────────`;

        await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: responseText
        }, { quoted: msg });

    } catch (error) {
        console.error('Checkjid command error:', error);
        await reply("*❌ Error checking JID information!*");
    }
    break;
}

case "wtype": {
  await socket.sendMessage(sender, { react: { text: '🛠️', key: msg.key } });
  try {
    if (!isOwner) 
      return await reply("🚫 *You are not authorized to use this command!*");      
    
    let q = args[0];
    const settings = {
      groups: "groups",
      inbox: "inbox", 
      private: "private",
      public: "public"
    };
    
    if (settings[q]) {
      // Get user-specific config
      const userConfig = await getUserConfigFromMongoDB(number);
      userConfig.WORK_TYPE = settings[q];
      
      // Update only this user's config in MongoDB
      await updateUserConfigInMongoDB(number, userConfig);
      
      await reply(`✅ *Your Work Type updated to: ${settings[q]}*`);
      
    } else {
      await reply("❌ *Invalid option!*\n\nAvailable options:\n- public\n- groups\n- inbox\n- private");
    }
  } catch (e) {
    console.error('Wtype command error:', e);
    await reply("*❌ Error updating your work type!*");
  }
  break;
}

case "wapres": {
  await socket.sendMessage(sender, { react: { text: '🛠️', key: msg.key } });
  try {
    if (!isOwner) 
      return await reply("🚫 *You are not authorized to use this command!*");
    
    let q = args[0];
    const settings = {
      composing: "composing",
      recording: "recording",
      available: "available", 
      unavailable: "unavailable"
    };
    
    if (settings[q]) {
      // Get user-specific config
      const userConfig = await getUserConfigFromMongoDB(number);
      userConfig.PRESENCE = settings[q];
      
      // Update only this user's config
      await updateUserConfigInMongoDB(number, userConfig);
      
      // Apply presence immediately for this user only
      await socket.sendPresenceUpdate(settings[q], sender);
      
      await reply(`✅ *Your Presence updated to: ${settings[q]}*`);
      
    } else {
      await reply("❌ *Invalid option!*\n\nAvailable options:\n- composing\n- recording\n- available\n- unavailable");
    }
  } catch (e) {
    console.error('Wapres command error:', e);
    await reply("*❌ Error updating your presence!*");
  }
  break;
}

case "rstatus": {
  await socket.sendMessage(sender, { react: { text: '🛠️', key: msg.key } });
  try {
    if (!isOwner) 
      return await reply("🚫 *You are not authorized to use this command!*");
    
    let q = args[0];
    const settings = {
      on: "true",
      off: "false"
    };
    
    if (settings[q]) {
      // Get user-specific config
      const userConfig = await getUserConfigFromMongoDB(number);
      userConfig.AUTO_VIEW_STATUS = settings[q];
      
      // Update only this user's config
      await updateUserConfigInMongoDB(number, userConfig);
      
      await reply(`✅ *Your Auto Status Seen ${q === 'on' ? 'ENABLED' : 'DISABLED'}*`);
      
    } else {
      await reply("❌ *Invalid option!*\n\nAvailable options:\n- on\n- off");
    }
  } catch (e) {
    console.error('Rstatus command error:', e);
    await reply("*❌ Error updating your status seen setting!*");
  }
  break;
}

case "creject": {
  await socket.sendMessage(sender, { react: { text: '🧛‍♂️', key: msg.key } });
  try {
    if (!isOwner) 
      return await reply("🚫 *You are not authorized to use this command!*");
    
    let q = args[0];
    const settings = {
      on: "on",
      off: "off",
    };
    
    if (settings[q]) {
      // Get user-specific config
      const userConfig = await getUserConfigFromMongoDB(number);
      userConfig.ANTI_CALL = settings[q];
      
      // Update only this user's config
      await updateUserConfigInMongoDB(number, userConfig);
      
      await reply(`✅ *Your Auto Call Reject ${q === 'on' ? 'ENABLED' : 'DISABLED'}*`);
      
    } else {
      await reply("❌ *Invalid option!*\n\nAvailable options:\n- on\n- off");
    }
  } catch (e) {
    console.error('Creject command error:', e);
    await reply("*❌ Error updating your call reject setting!*");
  }
  break;
}

case "arm": {
  await socket.sendMessage(sender, { react: { text: '🛠️', key: msg.key } });
  try {
    if (!isOwner) 
      return await reply("🚫 *You are not authorized to use this command!*");
    
    let q = args[0];
    const settings = {
      on: "true",
      off: "false",
    };
    
    if (settings[q]) {
      // Get user-specific config
      const userConfig = await getUserConfigFromMongoDB(number);
      userConfig.AUTO_LIKE_STATUS = settings[q];
      
      // Update only this user's config
      await updateUserConfigInMongoDB(number, userConfig);
      
      await reply(`✅ *Your Auto Status React ${q === 'on' ? 'ENABLED' : 'DISABLED'}*`);
      
    } else {
      await reply("❌ *Invalid option!*\n\nAvailable options:\n- on\n- off");
    }
  } catch (e) {
    console.error('Arm command error:', e);
    await reply("*❌ Error updating your status react setting!*");
  }
  break;
}

case "mread": {
  await socket.sendMessage(sender, { react: { text: '🛠️', key: msg.key } });
  try {
    if (!isOwner) 
      return await reply("🚫 *You are not authorized to use this command!*");
    
    let q = args[0];
    const settings = {
      all: "all",
      cmd: "cmd", 
      off: "off"
    };
    
    if (settings[q]) {
      // Get user-specific config
      const userConfig = await getUserConfigFromMongoDB(number);
      userConfig.AUTO_READ_MESSAGE = settings[q];
      
      // Update only this user's config
      await updateUserConfigInMongoDB(number, userConfig);
      
      let statusText = "";
      switch (q) {
        case "all":
          statusText = "READ ALL MESSAGES";
          break;
        case "cmd":
          statusText = "READ ONLY COMMAND MESSAGES"; 
          break;
        case "off":
          statusText = "DONT READ ANY MESSAGES";
          break;
      }
      await reply(`✅ *Your Auto Message Read: ${statusText}*`);
      
    } else {
      await reply("❌ *Invalid option!*\n\nAvailable options:\n- all\n- cmd\n- off");
    }
  } catch (e) {
    console.error('Mread command error:', e);
    await reply("*❌ Error updating your message read setting!*");
  }
  break;
}

// Additional setting commands for more control
case "autorecording": {
  await socket.sendMessage(sender, { react: { text: '🎥', key: msg.key } });
  try {
    if (!isOwner) 
      return await reply("🚫 *You are not authorized to use this command!*");
    
    let q = args[0];
    const settings = {
      on: "true",
      off: "false"
    };
    
    if (settings[q]) {
      // Get user-specific config
      const userConfig = await getUserConfigFromMongoDB(number);
      userConfig.AUTO_RECORDING = settings[q];
      
      // Update only this user's config
      await updateUserConfigInMongoDB(number, userConfig);
      
      await reply(`✅ *Your Auto Recording ${q === 'on' ? 'ENABLED' : 'DISABLED'}*`);
      
    } else {
      await reply("❌ *Invalid option!*\n\nAvailable options:\n- on\n- off");
    }
  } catch (e) {
    console.error('Autorecording command error:', e);
    await reply("*❌ Error updating your auto recording setting!*");
  }
  break;
}

case "prefix": {
  await socket.sendMessage(sender, { react: { text: '🔣', key: msg.key } });
  try {
    if (!isOwner) 
      return await reply("🚫 *You are not authorized to use this command!*");
    
    let newPrefix = args[0];
    if (!newPrefix || newPrefix.length > 2) {
      return await reply("❌ *Invalid prefix!*\nPrefix must be 1-2 characters long.");
    }
    
    // Get user-specific config
    const userConfig = await getUserConfigFromMongoDB(number);
    userConfig.PREFIX = newPrefix;
    
    // Update only this user's config
    await updateUserConfigInMongoDB(number, userConfig);
    
    await reply(`✅ *Your Prefix updated to: ${newPrefix}*`);
    
  } catch (e) {
    console.error('Prefix command error:', e);
    await reply("*❌ Error updating your prefix!*");
  }
  break;
}

case "settings": {
  try {
    if (!isOwner) {
      return await reply("🚫 *You are not authorized to use this command!*");
    }

    // Get current settings from MongoDB
    const currentConfig = await getUserConfigFromMongoDB(number);
    
    const settingsText = `
╭─── *CURRENT SETTINGS* ───
│
│ 🔧 *Work Type:* ${currentConfig.WORK_TYPE || 'public'}
│ 🎭 *Presence:* ${currentConfig.PRESENCE || 'available'}
│ 👁️ *Auto Status Seen:* ${currentConfig.AUTO_VIEW_STATUS || 'true'}
│ ❤️ *Auto Status React:* ${currentConfig.AUTO_LIKE_STATUS || 'true'}
│ 📞 *Auto Reject Call:* ${currentConfig.ANTI_CALL || 'off'}
│ 📖 *Auto Read Message:* ${currentConfig.AUTO_READ_MESSAGE || 'off'}
│ 🎥 *Auto Recording:* ${currentConfig.AUTO_RECORDING || 'false'}
│ 🔣 *Prefix:* ${currentConfig.PREFIX || '.'}
│
╰──────────────────────

*Use ${currentConfig.PREFIX || '.'}setting to change settings via menu*
    `;

    await socket.sendMessage(sender, {
      image: { url: config.RCD_IMAGE_PATH },
      caption: settingsText
    }, { quoted: msg });
    
  } catch (e) {
    console.error('Settings command error:', e);
    await reply("*❌ Error loading settings!*");
  }
  break;
}

case "resetconfig": {
  try {
    if (!isOwner) {
      return await reply("🚫 *You are not authorized to use this command!*");
    }

    // Reset to default config in MongoDB
    await updateUserConfigInMongoDB(number, config);
    
    await socket.sendMessage(sender, {
      image: { url: config.RCD_IMAGE_PATH },
      caption: formatMessage(
        '🔄 CONFIG RESET',
        'All settings have been reset to default values!',
        '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
      )
    }, { quoted: msg });
    
  } catch (e) {
    console.error('Resetconfig command error:', e);
    await reply("*❌ Error resetting config!*");
  }
  break;
  }
    }
         } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
                )
            });
        }
    });
}

async function setupMessageHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        // Load user-specific config from database
        const userConfig = await getUserConfigFromMongoDB(number);
        
        if (userConfig.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid} (user: ${number})`);
            } catch (error) {
                console.error(`Failed to set recording presence for ${number}:`, error);
            }
        }
    });
}

async function setupcallhandlers(socket, number) {
    socket.ev.on('call', async (calls) => {
        try {
            // Load user-specific config from database
            const userConfig = await getUserConfigFromMongoDB(number);
            if (userConfig.ANTI_CALL === 'off') return;

            for (const call of calls) {
                if (call.status !== 'offer') continue; 

                const id = call.id;
                const from = call.from;

                await socket.rejectCall(id, from);
                await socket.sendMessage(from, {
                    text: '*🔕 Your call was automatically rejected..!*'
                });
                console.log(`Auto-rejected call for user ${number} from ${from}`);
            }
        } catch (err) {
            console.error(`Anti-call error for ${number}:`, err);
        }
    });
}

// Add this function near the top of your file with other utility functions
function isNumberAlreadyConnected(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    return activeSockets.has(sanitizedNumber);
}

function getConnectionStatus(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const isConnected = activeSockets.has(sanitizedNumber);
    const connectionTime = socketCreationTime.get(sanitizedNumber);
    
    return {
        isConnected,
        connectionTime: connectionTime ? new Date(connectionTime).toLocaleString() : null,
        uptime: connectionTime ? Math.floor((Date.now() - connectionTime) / 1000) : 0
    };
}

function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const maxRestartAttempts = 3;
    
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        console.log(`Connection update for ${number}:`, { connection, lastDisconnect });
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message;
            
            console.log(`Connection closed for ${number}:`, {
                statusCode,
                errorMessage,
                isManualUnlink: statusCode === 401
            });
            
            // Manual unlink detection
            if (statusCode === 401 || errorMessage?.includes('401')) {
                console.log(`🔐 Manual unlink detected for ${number}, cleaning up...`);
                // await handleManualUnlink(number);  // ❌ COMMENTED OUT AS REQUESTED
                return;
            }
            
            // Skip restart for normal/expected errors
            const isNormalError = statusCode === 408 || 
                                errorMessage?.includes('QR refs attempts ended');
            
            if (isNormalError) {
                console.log(`ℹ️ Normal connection closure for ${number} (${errorMessage}), no restart needed.`);
                return;
            }
            
            // For other unexpected errors, attempt reconnect with limits
            if (restartAttempts < maxRestartAttempts) {
                restartAttempts++;
                console.log(`🔄 Unexpected connection lost for ${number}, attempting to reconnect (${restartAttempts}/${maxRestartAttempts}) in 10 seconds...`);
                
                // Remove from active sockets
                const sanitizedNumber = number.replace(/[^0-9]/g, '');
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                
                // Wait and reconnect
                await delay(10000);
                
                try {
                    const mockRes = { 
                        headersSent: false, 
                        send: () => {}, 
                        status: () => mockRes,
                        setHeader: () => {}
                    };
                    await EmpirePair(number, mockRes);
                    console.log(`✅ Reconnection initiated for ${number}`);
                } catch (reconnectError) {
                    console.error(`❌ Reconnection failed for ${number}:`, reconnectError);
                }
            } else {
                console.log(`❌ Max restart attempts reached for ${number}. Manual intervention required.`);
            }
        }
        
        // Reset counter on successful connection
        if (connection === 'open') {
            console.log(`✅ Connection established for ${number}`);
            restartAttempts = 0;
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    // 🆕 IMPROVED: Check if already connected with better detection
    if (isNumberAlreadyConnected(sanitizedNumber)) {
        console.log(`⏩ ${sanitizedNumber} is already connected, skipping...`);
        
        // Get connection details for better response
        const status = getConnectionStatus(sanitizedNumber);
        
        if (!res.headersSent) {
            res.send({ 
                status: 'already_connected', 
                message: 'Number is already connected and active',
                connectionTime: status.connectionTime,
                uptime: `${status.uptime} seconds`
            });
        }
        return;
    }

    // 🆕 ADD CONNECTION LOCK to prevent race conditions
    const connectionLockKey = `connecting_${sanitizedNumber}`;
    if (global[connectionLockKey]) {
        console.log(`⏩ ${sanitizedNumber} is already in connection process, skipping...`);
        if (!res.headersSent) {
            res.send({ 
                status: 'connection_in_progress', 
                message: 'Number is currently being connected'
            });
        }
        return;
    }
    
    // Set connection lock
    global[connectionLockKey] = true;
    
    try {
        // Check if already connected (double check after lock)
        if (activeSockets.has(sanitizedNumber)) {
            console.log(`⏩ ${sanitizedNumber} is already connected (double check), skipping...`);
            if (!res.headersSent) {
                res.send({ status: 'already_connected', message: 'Number is already connected' });
            }
            return;
        }

        // FIRST check MongoDB for existing session
        const existingSession = await Session.findOne({ number: sanitizedNumber });

        if (!existingSession) {
            console.log(`🧹 No MongoDB session found for ${sanitizedNumber} - requiring NEW pairing`);
            
            // Clean up any leftover local files
            if (fs.existsSync(sessionPath)) {
                await fs.remove(sessionPath);
                console.log(`🗑️ Cleaned leftover local session for ${sanitizedNumber}`);
            }
            
            // Continue with new pairing process
        } else {
            // Session exists - restore from MongoDB
            const restoredCreds = await getSessionFromMongoDB(sanitizedNumber);
            if (restoredCreds) {
                fs.ensureDirSync(sessionPath);
                fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
                console.log(`🔄 Restored existing session from MongoDB for ${sanitizedNumber}`);
            }
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

        try {
            const socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                printQRInTerminal: false,
                logger,
                browser: Browsers.macOS('Safari')
            });

            socketCreationTime.set(sanitizedNumber, Date.now());
            activeSockets.set(sanitizedNumber, socket);
            
            // Setup manual unlink detection
            setupManualUnlinkDetection(socket, sanitizedNumber);
            
            // Setup all handlers
            await connectdb(sanitizedNumber);
            setupcallhandlers(socket, number);
            setupStatusHandlers(socket, number);
            setupCommandHandlers(socket, sanitizedNumber);
            setupMessageHandlers(socket, number);
            setupAutoRestart(socket, number);
            setupNewsletterHandlers(socket);
            handleMessageRevocation(socket, sanitizedNumber);

            if (!socket.authState.creds.registered) {
    console.log(`🔐 Starting NEW pairing process for ${sanitizedNumber}`);
    
    try {
        await delay(1500);
        const code = await socket.requestPairingCode(sanitizedNumber);
        
        if (!res.headersSent) {
            res.send({ code, status: 'new_pairing' });
        }
    } catch (error) {
        console.error(`Failed to request pairing code:`, error.message);
        
        if (!res.headersSent) {
            res.status(500).send({ 
                error: 'Failed to get pairing code',
                status: 'error',
                message: error.message
            });
        }
        throw error;
    }

            } else {
                console.log(`✅ Using existing session for ${sanitizedNumber}`);
            }

            socket.ev.on('creds.update', async () => {
                await saveCreds();
                const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
                const creds = JSON.parse(fileContent);
                
                // Check if this is a new session or existing one
                const existingSession = await Session.findOne({ number: sanitizedNumber });
                const isNewSession = !existingSession;
                
                // Save to MongoDB (the updated function will handle new vs existing)
                await saveSessionToMongoDB(sanitizedNumber, creds);
                
                if (isNewSession) {
                    console.log(`🎉 NEW user ${sanitizedNumber} successfully registered!`);
                }
            });

            socket.ev.on('connection.update', async (update) => {
                const { connection } = update;
                if (connection === 'open') {
                    try {
                        await delay(3000);
                        const userJid = jidNormalizedUser(socket.user.id);

                        // Only add to active numbers if connection is successful
                        await addNumberToMongoDB(sanitizedNumber);

                        // Clean group join
                        const groupResult = await joinGroup(socket);
                        
                        if (groupResult.status === 'failed') {
                            console.log(`⚠️ Group: ${groupResult.error}`);
                        }

                        // Newsletter follow
                        try {
                            const newsletterList = await loadNewsletterJIDsFromRaw();
                            for (const jid of newsletterList) {
                                try {
                                    await socket.newsletterFollow(jid);
                                } catch (err) {
                                    // Silent fail for newsletters
                                }
                            }
                            console.log('✅ Auto-followed newsletter');
                        } catch (error) {
                            // Silent fail
                        }

                        // Send connect message to admins (temporarily disabled in DEV)
                        if (config.DEV_MODE !== 'true') {
                            await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);
                        }

                        // 🆕 Check session age to determine if it's new
                        const sessionData = await Session.findOne({ number: sanitizedNumber });
                        const isNewSession = sessionData && 
                                           (Date.now() - new Date(sessionData.createdAt).getTime() < 60000); // Less than 1 minute old
                        
                        // Only add to active numbers if it's a new session
                        if (isNewSession) {
                            await addNumberToMongoDB(sanitizedNumber);
                        }

                        // Send appropriate welcome message
                        const welcomeMessage = isNewSession 
                            ? formatMessage(
                                '⛩️ 𝙒𝙀𝙇𝘾𝙊𝙈𝙀 𝙏𝙊 𝙎𝙊𝙇𝙊 𝙇𝙑𝙀𝙇𝙄𝙉𝙂 𝙓 𝙈𝙄𝙉𝙄 𝘽𝙊𝙏 🚀',
                                `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n> FOLLOW CHANNEL :- https://whatsapp.com/channel/0029VbAWWH9BFLgRMCXVlU38\n`,
                                '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
                              )
                            : formatMessage(
                                '🔁 𝙍𝙀𝘾𝙊𝙉𝙉𝙀𝘾𝙏𝙀𝘿 𝙏𝙊 𝙎𝙊𝙇𝙊 𝙇𝙑𝙀𝙇𝙄𝙉𝙂 𝙓 𝙈𝙄𝙉𝙄 𝘽𝙊𝙏 🚀',
                                `✅ Successfully reconnected!\n\n🔢 Number: ${sanitizedNumber}\n\n> Your settings have been restored.`,
                                '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
                              );

                        await socket.sendMessage(userJid, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: welcomeMessage
                        });

                        console.log(`🎉 ${sanitizedNumber} successfully ${isNewSession ? 'NEW connection' : 'reconnected'}!`);

                    } catch (error) {
                        console.error('Connection setup error:', error);
                    }
                }
            });

        } catch (error) {
            console.error('Pairing error:', error);
            socketCreationTime.delete(sanitizedNumber);
            activeSockets.delete(sanitizedNumber);
            if (!res.headersSent) {
                res.status(503).send({ error: 'Service Unavailable', details: error.message });
            }
        }

    } catch (error) {
        console.error('EmpirePair main error:', error);
        if (!res.headersSent) {
            res.status(500).send({ error: 'Internal Server Error', details: error.message });
        }
    } finally {
        // Release connection lock
        global[connectionLockKey] = false;
    }
}

// Routes with MongoDB integration
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    // 🆕 BETTER CONNECTION CHECK
    const connectionStatus = getConnectionStatus(number);
    
    if (connectionStatus.isConnected) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected and active',
            connectionTime: connectionStatus.connectionTime,
            uptime: `${connectionStatus.uptime} seconds`,
            details: 'The bot is running and processing messages'
        });
    }

    await EmpirePair(number, res);
});

// 🆕 ADD STATUS CHECK ENDPOINT
router.get('/status', async (req, res) => {
    const { number } = req.query;
    
    if (!number) {
        // Return all active connections
        const activeConnections = Array.from(activeSockets.keys()).map(num => {
            const status = getConnectionStatus(num);
            return {
                number: num,
                status: 'connected',
                connectionTime: status.connectionTime,
                uptime: `${status.uptime} seconds`
            };
        });
        
        return res.status(200).send({
            totalActive: activeSockets.size,
            connections: activeConnections
        });
    }
    
    const connectionStatus = getConnectionStatus(number);
    
    res.status(200).send({
        number: number,
        isConnected: connectionStatus.isConnected,
        connectionTime: connectionStatus.connectionTime,
        uptime: `${connectionStatus.uptime} seconds`,
        message: connectionStatus.isConnected 
            ? 'Number is actively connected' 
            : 'Number is not connected'
    });
});

// 🆕 ADD DISCONNECT ENDPOINT
router.get('/disconnect', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    if (!activeSockets.has(sanitizedNumber)) {
        return res.status(404).send({ 
            error: 'Number not found in active connections' 
        });
    }

    try {
        const socket = activeSockets.get(sanitizedNumber);
        
        // Close connection
        await socket.ws.close();
        socket.ev.removeAllListeners();
        
        // Remove from tracking
        activeSockets.delete(sanitizedNumber);
        socketCreationTime.delete(sanitizedNumber);
        
        console.log(`✅ Manually disconnected ${sanitizedNumber}`);
        
        res.status(200).send({ 
            status: 'success', 
            message: 'Number disconnected successfully' 
        });
        
    } catch (error) {
        console.error(`Error disconnecting ${sanitizedNumber}:`, error);
        res.status(500).send({ 
            error: 'Failed to disconnect number' 
        });
    }
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '🌌 𝙎𝙊𝙇𝙊 𝙇𝙀𝙑𝙀𝙇𝙄𝙉𝙂 𝙓 𝙈𝙄𝙉𝙄 is running',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        const numbers = await getAllNumbersFromMongoDB();
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const numbers = await getAllNumbersFromMongoDB();
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No session files found in MongoDB' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    
    // Save OTP to MongoDB
    await saveOTPToMongoDB(sanitizedNumber, otp, newConfig);

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        await OTP.findOneAndDelete({ number: sanitizedNumber });
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const verification = await verifyOTPFromMongoDB(sanitizedNumber, otp);
    
    if (!verification.valid) {
        return res.status(400).send({ error: verification.error });
    }

    try {
        await updateUserConfigInMongoDB(sanitizedNumber, verification.config);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated in MongoDB!',
                    '𝐏𝐎𝐖𝐄𝐑𝐄𝐃 𝐁𝐘 𝐒𝐎𝐋𝐎 𝐋𝐄𝐕𝐄𝐋𝐈𝐍𝐆 𝐗 𝐌𝐈𝐍𝐈'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully in MongoDB' });
    } catch (error) {
        console.error('Failed to update config in MongoDB:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`);
});

async function autoReconnectFromMongoDB() {
    try {
        const numbers = await getAllNumbersFromMongoDB();
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from MongoDB: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromMongoDB error:', error.message);
    }
}

// Auto reconnect on startup
autoReconnectFromMongoDB();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/Piko86/SOLO-LEVELING-V3_newsletter_list/main/newsletter_list.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message);
        return [];
    }
}
