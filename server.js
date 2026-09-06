const express = require("express");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const svgCaptcha = require("svg-captcha");
const db = require("./database");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const { google } = require("googleapis");
const { authenticate } = require("@google-cloud/local-auth");
const { OAuth2Client } = require("google-auth-library");

const app = express();
const PORT = 3000;

// -------------------------
// Basic server setup
// -------------------------

app.use(cors());
app.use(express.json());

app.use(session({
    secret: "exam-platform-secret",
    resave: false,
    saveUninitialized: false
}));

app.get("/admin.html", (req, res) => {
    if (
        !req.session.adminId ||
        req.session.role !== "examiner"
    ) {
        return res.redirect("/admin-login.html");
    }

    res.sendFile(
        path.join(__dirname, "public", "admin.html")
    );
});
app.get("/student-portal.html", (req, res) => {
    if (
        !req.session.adminId ||
        req.session.role !== "student"
    ) {
        return res.redirect("/admin-login.html");
    }

    res.sendFile(
        path.join(__dirname, "public", "student-portal.html")
    );
});

app.use(express.static("public", {
    index: false
}));

app.get("/", (req, res) => {
    if (req.session.adminId) {
        if (req.session.role === "examiner") {
            return res.redirect("/admin.html");
        }

        if (req.session.role === "student") {
            return res.redirect("/student-portal.html");
        }
    }

    res.sendFile(
        path.join(__dirname, "public", "admin-login.html")
    );
});

// Make sure uploads folder exists
fs.mkdirSync("uploads", { recursive: true });

const upload = multer({
    dest: "uploads/"
});
const questionBankUpload = multer({
    dest: "question-banks/",
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname).toLowerCase() !== ".txt") {
            return cb(new Error("Only .txt files are allowed."));
        }

        cb(null, true);
    }
});
// -------------------------
// Question Bank Upload
// -------------------------

app.post(
    "/api/question-banks/upload",
    questionBankUpload.single("questionBank"),
    (req, res) => {

        if (!req.session.adminId || req.session.role !== "examiner") {
            return res.status(403).json({
                success: false,
                error: "Examiner access required."
            });
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: "Please upload a .txt file."
            });
        }

        try {

            console.log(
                "Question bank uploaded:",
                req.file.originalname
            );

            const content = fs.readFileSync(
                req.file.path,
                "utf8"
            );

            // Delete temporary uploaded file
            fs.unlinkSync(req.file.path);

            if (!content.trim()) {
                return res.status(400).json({
                    success: false,
                    error: "The question bank is empty."
                });
            }

            // Split questions by blank lines
            const blocks = content
                .split(/\n\s*\n/)
                .map(block => block.trim())
                .filter(block => block.length > 0);

            const questions = [];

            for (const block of blocks) {

                const lines = block
                    .split("\n")
                    .map(line => line.trim())
                    .filter(line => line.length > 0);

                if (lines.length < 6) {
                    continue;
                }

                const question =
                    lines[0].replace(/^Q\d+:\s*/i, "");

                const options = [
                    lines[1].replace(/^A\)\s*/i, ""),
                    lines[2].replace(/^B\)\s*/i, ""),
                    lines[3].replace(/^C\)\s*/i, ""),
                    lines[4].replace(/^D\)\s*/i, "")
                ];

                const answer =
                    lines[5]
                        .replace(/^ANSWER:\s*/i, "")
                        .trim()
                        .toUpperCase();

                if (
                    question &&
                    options.every(option => option) &&
                    ["A", "B", "C", "D"].includes(answer)
                ) {
                    questions.push({
                        question,
                        options,
                        answer
                    });
                }
            }

            // Make sure at least one valid question exists
            if (questions.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: "No valid questions were found. Check the .txt format."
                });
            }

            // Save question bank
            const result = db.prepare(`
                INSERT INTO question_banks
                (name, questions, admin_id, created_at)
                VALUES (?, ?, ?, ?)
            `).run(
                req.file.originalname.replace(/\.txt$/i, ""),
                JSON.stringify(questions),
                req.session.adminId,
                new Date().toISOString()
            );

            console.log(
                "Question bank saved:",
                result.lastInsertRowid
            );

            return res.json({
                success: true,
                bankId: result.lastInsertRowid,
                name: req.file.originalname,
                questionCount: questions.length
            });

        } catch (error) {

            console.error(
                "Question bank upload error:",
                error
            );

            if (!res.headersSent) {
                return res.status(500).json({
                    success: false,
                    error: "Could not upload question bank."
                });
            }
        }
    }
);
// -------------------------
// Question Bank APIs
// -------------------------

app.get("/api/question-banks", (req, res) => {

    if (!req.session.adminId || req.session.role !== "examiner") {
        return res.status(403).json({
            success: false,
            error: "Examiner access required."
        });
    }

    try {

        const banks = db.prepare(`
            SELECT id, name, questions, created_at
            FROM question_banks
            WHERE admin_id = ?
            ORDER BY id DESC
        `).all(req.session.adminId);

        const formattedBanks = banks.map(bank => {

            const questions = JSON.parse(bank.questions);

            return {
                id: bank.id,
                name: bank.name,
                questionCount: questions.length,
                created_at: bank.created_at
            };

        });

        return res.json({
            success: true,
            banks: formattedBanks
        });

    } catch (error) {

        console.error("Question bank list error:", error);

        return res.status(500).json({
            success: false,
            error: "Could not load question banks."
        });
    }
});


app.get("/api/question-banks/:id", (req, res) => {

    if (!req.session.adminId || req.session.role !== "examiner") {
        return res.status(403).json({
            success: false,
            error: "Examiner access required."
        });
    }

    try {

        const bank = db.prepare(`
            SELECT id, name, questions, created_at
            FROM question_banks
            WHERE id = ? AND admin_id = ?
        `).get(
            req.params.id,
            req.session.adminId
        );

        if (!bank) {
            return res.status(404).json({
                success: false,
                error: "Question bank not found."
            });
        }

        bank.questions = JSON.parse(bank.questions);

        return res.json({
            success: true,
            bank
        });

    } catch (error) {

        console.error("Question bank view error:", error);

        return res.status(500).json({
            success: false,
            error: "Could not load question bank."
        });
    }
});


app.delete("/api/question-banks/:id", (req, res) => {

    if (!req.session.adminId || req.session.role !== "examiner") {
        return res.status(403).json({
            success: false,
            error: "Examiner access required."
        });
    }

    try {

        const result = db.prepare(`
            DELETE FROM question_banks
            WHERE id = ? AND admin_id = ?
        `).run(
            req.params.id,
            req.session.adminId
        );

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                error: "Question bank not found."
            });
        }

        return res.json({
            success: true,
            message: "Question bank deleted."
        });

    } catch (error) {

        console.error("Question bank delete error:", error);

        return res.status(500).json({
            success: false,
            error: "Could not delete question bank."
        });
    }
});

// -------------------------
// Exam data
// -------------------------
const exams = {};
const attempts = {};
app.post("/api/admin/login", (req, res) => {
    const { email, password } = req.body;

    const admin = db.prepare(`
        SELECT * FROM admins
        WHERE email = ?
    `).get(email);

    if (!admin) {
        return res.status(401).json({
            success: false,
            error: "Invalid email or password."
        });
    }
    const passwordCorrect =
        bcrypt.compareSync(password, admin.password);

    if (!passwordCorrect) {
        return res.status(401).json({
            success: false,
            error: "Invalid email or password."
        });
    }

   req.session.adminId = admin.id;
req.session.adminEmail = admin.email;
req.session.role = admin.role;

res.json({
    success: true,
    role: admin.role
});
});


app.post("/api/admin/logout", (req, res) => {
    req.session.destroy(() => {
        res.json({
            success: true
        });
    });
});


// -------------------------
// Google Drive
// -------------------------

const SCOPES = [
    "https://www.googleapis.com/auth/drive.file"
];

let drive;

// Authenticate with Google Drive
async function authorizeGoogleDrive() {
    console.log("Connecting to Google Drive...");

    // Login using Google's local authentication
    const auth = await authenticate({
        scopes: SCOPES,
        keyfilePath: path.join(
            __dirname,
            "credentials.json"
        )
    });

    console.log("Google authentication successful.");

    // Read the OAuth client information
    const credentialsFile = JSON.parse(
        fs.readFileSync(
            path.join(__dirname, "credentials.json"),
            "utf8"
        )
    );

    const keys =
        credentialsFile.installed ||
        credentialsFile.web;

    if (!keys) {
        throw new Error(
            "Could not find installed/web OAuth credentials."
        );
    }

    // Create the OAuth client from the SAME library
    // used by googleapis
    const oauth2Client = new google.auth.OAuth2(
        keys.client_id,
        keys.client_secret,
        keys.redirect_uris[0]
    );

    // Transfer the tokens obtained during login
    oauth2Client.setCredentials(
        auth.credentials
    );

    // Make sure we have a usable access token
    const token =
        await oauth2Client.getAccessToken();

    if (!token.token) {
        throw new Error(
            "No Google access token was available."
        );
    }

    console.log("Google access token received.");

    // IMPORTANT: Drive now uses googleapis' own OAuth client
    drive = google.drive({
        version: "v3",
        auth: oauth2Client
    });

    console.log(
        "Google Drive connected successfully!"
    );
}
// -------------------------
// Create exam
// -------------------------

app.post("/api/exams", (req, res) => {

    const {
        title,
        duration,
        bankId,
        questionCount
    } = req.body;

    // Check examiner login
    if (!req.session.adminId || req.session.role !== "examiner") {
        return res.status(403).json({
            success: false,
            error: "Examiner access required."
        });
    }

    // Validate basic information
    if (!title || !duration || !bankId || !questionCount) {
        return res.status(400).json({
            success: false,
            error: "Please provide exam title, duration, question bank and question count."
        });
    }

    try {

        // Get the selected question bank
        const bank = db.prepare(`
            SELECT id, name, questions
            FROM question_banks
            WHERE id = ? AND admin_id = ?
        `).get(
            bankId,
            req.session.adminId
        );

        if (!bank) {
            return res.status(404).json({
                success: false,
                error: "Question bank not found."
            });
        }

        // Convert stored questions back into an array
        const questions = JSON.parse(bank.questions);

        // Make sure requested number is possible
        if (
            Number(questionCount) < 1 ||
            Number(questionCount) > questions.length
        ) {
            return res.status(400).json({
                success: false,
                error: `This question bank contains ${questions.length} questions.`
            });
        }

        // Generate exam ID
        const examId =
            Math.random()
                .toString(36)
                .substring(2, 8);

        /*
         * For now we store the question bank information
         * with the exam.
         *
         * Later, when a student starts the exam,
         * the server will randomly select the required
         * number of questions from this bank.
         */
        const examData = {
            bankId: Number(bankId),
            questionCount: Number(questionCount)
        };

        // Save exam
        db.prepare(`
            INSERT INTO exams
            (id, title, duration, questions, admin_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            examId,
            title,
            Number(duration),
            JSON.stringify(examData),
            req.session.adminId,
            new Date().toISOString()
        );

        console.log(
            "Exam saved to database:",
            examId
        );

        return res.json({
            success: true,
            examId: examId
        });

    } catch (error) {

        console.error(
            "Exam creation error:",
            error
        );

        return res.status(500).json({
            success: false,
            error: "Could not create exam."
        });
    }
});

// -------------------------
// Get exam
// -------------------------
app.get("/api/exams", (req, res) => {

    if (!req.session.adminId) {
        return res.status(401).json({
            error: "You must be logged in."
        });
    }

    const exams = db.prepare(`
        SELECT id, title, duration, created_at
        FROM exams
        ORDER BY created_at DESC
    `).all();

    res.json(exams);
});
app.get("/api/exams/:id", (req, res) => {
        if (!req.session.adminId) {
        return res.status(401).json({
            error: "You must be logged in."
        });
    }

    const exam = db.prepare(`
        SELECT * FROM exams
        WHERE id = ?
    `).get(req.params.id);

    if (!exam) {
        return res.status(404).json({
            error: "Exam not found"
        });
    }

    exam.questions = JSON.parse(exam.questions);

    res.json(exam);
});

// -------------------------
// Upload video to Google Drive
// -------------------------

async function uploadToDrive(
    filePath,
    fileName,
    mimeType
) {

    if (!drive) {
        throw new Error(
            "Google Drive is not connected."
        );
    }

    const response =
        await drive.files.create({

            requestBody: {
                name: fileName
            },

            media: {
                mimeType: mimeType,
                body: fs.createReadStream(filePath)
            },

            fields: "id,name,webViewLink"
        });

    return response.data;
}

// -------------------------
// Save exam attempt
// -------------------------

app.post(
    "/api/attempts",
    upload.single("video"),
    async (req, res) => {

        try {

            const attemptId =
                Math.random()
                    .toString(36)
                    .substring(2, 10);

            let driveFile = null;

            // Upload recording
            if (req.file) {

                console.log(
                    "Uploading recording to Google Drive..."
                );

                driveFile =
                    await uploadToDrive(
                        req.file.path,
                        `exam-${req.body.examId}-attempt-${attemptId}.webm`,
                        req.file.mimetype
                    );

                console.log(
                    "Recording uploaded:",
                    driveFile.id
                );
            }

            attempts[attemptId] = {

                id: attemptId,

                examId:
                    req.body.examId,

                studentName:
                    req.body.studentName,

                answers:
                    JSON.parse(
                        req.body.answers || "{}"
                    ),

                status:
                    req.body.status,

                reason:
                    req.body.reason || null,

                video:
                    driveFile
                        ? driveFile.id
                        : null,

                time:
                    new Date().toISOString()
            };

            // Delete temporary local recording
            if (req.file) {
                fs.unlink(
                    req.file.path,
                    () => {}
                );
            }

            console.log(
                "Attempt saved:",
                attempts[attemptId]
            );

            res.json({

                success: true,

                attemptId:
                    attemptId,

                driveFileId:
                    driveFile
                        ? driveFile.id
                        : null
            });

        } catch (error) {

            console.error(
                "Upload error:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    "Could not save recording."
            });
        }
    }
);

// -------------------------
// Start server
// -------------------------

async function startServer() {

    try {

        await authorizeGoogleDrive();

        app.listen(
            PORT,
            () => {

                console.log("");
                console.log(
                    "================================"
                );
                console.log(
                    `Server running at http://localhost:${PORT}`
                );
                console.log(
                    "Google Drive: CONNECTED"
                );
                console.log(
                    "================================"
                );
                console.log("");
            }
        );

    } catch (error) {

        console.error("");
        console.error(
            "Google Drive authentication failed."
        );
        console.error(error);
        console.error("");
    }
}

startServer();