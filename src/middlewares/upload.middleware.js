import multer from "multer";

const DEFAULT_MAX_SIZE_MB = Number(process.env.HR_UPLOAD_MAX_SIZE_MB || 25);
const MAX_FILES = Number(process.env.HR_UPLOAD_MAX_FILES || 5);

const createMulterMiddleware = (maxSizeMB) => {
    return multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: maxSizeMB * 1024 * 1024,
            files: MAX_FILES,
        },
        fileFilter: (req, file, cb) => {
            const allowedTypes = [
                "application/pdf",
                "image/jpeg",
                "image/png",
                "image/webp",
                "application/msword",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ];

            if (!allowedTypes.includes(file.mimetype)) {
                return cb(new Error("Unsupported file type"));
            }

            return cb(null, true);
        },
    });
};

const dynamicUpload = (req, res, next) => {
    return createMulterMiddleware(DEFAULT_MAX_SIZE_MB).array("files", MAX_FILES)(req, res, next);
};

export default dynamicUpload;
