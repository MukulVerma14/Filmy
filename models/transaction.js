const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  amount: { type: Number, required: true },
  type: { type: String, enum: ['income', 'expense'], required: true },
  category: { type: String, required: true },
  description: String,
  date: { type: Date, default: Date.now },
  notes: String,
  receipt: String, // URL to receipt image if uploaded
  tags: [String],
  isRecurring: { type: Boolean, default: false },
  recurringDetails: {
    frequency: String, // monthly, weekly, etc.
    nextDate: Date
  }
});

module.exports = mongoose.model("Transaction", transactionSchema); 