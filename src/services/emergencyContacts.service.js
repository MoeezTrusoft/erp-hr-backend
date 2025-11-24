import prisma from "../config/prisma.js";

export const createEmergencyContact = async (data, createdBy) => {
  return prisma.emergencyContacts.create({
    data: {
      ...data,
      employee_Id: Number(data.employee_Id),
    },
  });
};

export const getAllEmergencyContacts = async () => {
  return prisma.emergencyContacts.findMany({
    include: {
      employee: true,
    },
  });
};

export const getEmergencyContactById = async (id) => {
  return prisma.emergencyContacts.findUnique({
    where: { id: Number(id) },
    include: {
      employee: true,
    },
  });
};

export const updateEmergencyContact = async (id, data) => {
  return prisma.emergencyContacts.update({
    where: { id: Number(id) },
    data,
  });
};

export const deleteEmergencyContact = async (id) => {
  return prisma.emergencyContacts.delete({
    where: { id: Number(id) },
  });
};
