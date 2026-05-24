#pragma once
#ifdef __cplusplus
extern "C" {
#endif
void devtool_log_relay_start(const char* host, int port);
void devtool_log_relay_stop(void);
#ifdef __cplusplus
}
#endif
