import multer from "multer";

const createMulterMiddleware = (maxSizeMB) => {
    return multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: maxSizeMB * 1024 * 1024,
        },
    });
};

const dynamicUpload = (req, res, next) => {
    const maxSize = req.query.maxSize ? parseInt(req.query.maxSize, 10) : 300; // 300MB
    return createMulterMiddleware(maxSize).array("files", 10)(req, res, next);
};

export default dynamicUpload;
