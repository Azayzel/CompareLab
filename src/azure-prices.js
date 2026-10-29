'use strict';

// USD per million tokens, normalized from the public Consumption meters in East US.
// Only Global Standard text input/output meters are included, never Batch/Flex/PTU.
const models = {
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  'gpt-5': [1.25, 10],
  'gpt-5-mini': [0.25, 2],
  'gpt-5-nano': [0.05, 0.4],
  'gpt-5.6-luna': [0.2, 1.2, 0.4, 1.8],
  'gpt-5.6-terra': [2, 12, 4, 18],
  'gpt-5.6-sol': [4, 20, 8, 30],
  'gpt-6-luna': [0.1, 0.5, 0.2, 0.75],
  'gpt-6-sol': [2, 10, 4, 15],
  'gpt-6-astra': [10, 50, 20, 75],
  'gpt-6.1-sol': [2, 10, 4, 15],
  'gpt-6.1-terra': [1, 5, 2, 7.5],
  'o1': [15, 60],
  'o1-mini': [1.1, 4.4],
  'o1-pro': [150, 600],
  'o3': [2, 8],
  'o3-mini': [1.1, 4.4],
  'o3-pro': [20, 80],
  'o4-mini': [1.1, 4.4]
};

module.exports = {
  checkedAt: '2026-10-28',
  source: 'https://prices.azure.com/api/retail/prices',
  pricingPage: 'https://azure.microsoft.com/en-us/pricing/details/azure-openai/',
  models
};
