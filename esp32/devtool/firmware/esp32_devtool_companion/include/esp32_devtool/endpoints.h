#pragma once
#include <esp_http_server.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef esp_err_t (*devtool_http_handler_t)(httpd_req_t* req);

void devtool_register_http(const char* method, const char* path,
                           devtool_http_handler_t fn);

#ifdef __cplusplus
}
#endif
