// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// ESLint's simple-import-sort rules own frontend import ordering. Keep the
// root Prettier import-rewriting plugins from applying a conflicting order.
export default {
  plugins: [],
};
