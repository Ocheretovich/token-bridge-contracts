/*
 * Copyright 2019, Offchain Labs, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef checkpointresult_hpp
#define checkpointresult_hpp

#include <rocksdb/status.h>

#include <vector>

struct GetResults {
    uint32_t reference_count;
    rocksdb::Status status;
    std::vector<unsigned char> stored_value;
};

struct SaveResults {
    uint32_t reference_count;
    rocksdb::Status status;
    std::vector<unsigned char> storage_key;
};

struct DeleteResults {
    uint32_t reference_count;
    rocksdb::Status status;
};

template <typename T>
struct DbResult {
    rocksdb::Status status;
    uint32_t reference_count;
    T data;
};

#endif /* checkpointresult_hpp */