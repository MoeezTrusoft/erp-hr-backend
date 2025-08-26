export const addEmployee = (req, res) => {
    const { name, position } = req.body;
    // save to DB (placeholder)
    res.status(201).json({ message: "Employee added", employee: { name, position } });
};

export const getEmployees = (req, res) => {
    // fetch from DB (placeholder)
    res.json([{ id: 1, name: "John Doe", position: "Developer" }]);
};
