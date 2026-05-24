#pragma once
#include <cJSON.h>
#ifdef __cplusplus
extern "C" {
#endif

void devtool_verb_dispatcher_init(void);
void devtool_dispatcher_dispatch_line(const char* json_line);

#ifdef __cplusplus
}
#endif
