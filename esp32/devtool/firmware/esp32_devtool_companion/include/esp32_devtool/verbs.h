#pragma once
#include <cJSON.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef int (*devtool_verb_handler_t)(const cJSON* params,
                                       cJSON* out_result,
                                       int* out_error_code,
                                       const char** out_error_msg);

void devtool_register_verb(const char* method, devtool_verb_handler_t fn);

#ifdef __cplusplus
}
#endif
